#!/usr/bin/env python3
"""Flash a runtime image to a TSL6 module that is stuck in its bootloader.

The protocol comes from static analysis of the TSL6 boot image (V1.2.00):

    frame   = 55 7F TYPE LEN_H LEN_L PAYLOAD CHK
    CHK     = (TYPE + LEN_H + LEN_L + sum(PAYLOAD)) & 0xFF
    0x55    prepare   payload: 01 + UID14        reply: 1 status byte (0 = OK)
    0x53    start     payload: 01 + UID14        reply: echo, first byte 0xFF = rejected
    0x57    page      payload: 1026-byte page    reply: empty; no reply = verify failed
    0x45    finish    payload: 01 + UID14        reply: empty; module jumps to the app
    UID14   = module_id[4:12] + module_id[0:6]   (module ID = 12 bytes from 0x1FFFF7E8)

The bootloader accepts only target 1 (runtime). It writes pages to
0x08008000 + index * 0x400 and never touches itself or the config area
(0x08077800 and up). So a failed flash leaves the module in the bootloader.

Commands:
    scan                         list BLE devices (TSL/FFKJ names, or service FFF0)
    check  IMAGE                 validate an image file, no BLE
    status ADDRESS               send 0xA0 and print the reply (read-only)
    flash  ADDRESS IMAGE --id ID --yes

IMAGE is either a transport file (N x 1026-byte pages, each page starts with a
2-byte big-endian index) or the JSON reply of the vendor update server.

Needs: pip install bleak
"""
import argparse
import asyncio
import json
import sys
from collections import Counter

PAGE = 1026
PAYLOAD = 1024
MAX_PAGES = 0x17F00 // PAYLOAD + 1   # bootloader range check on the runtime slot
SVC_UUID = "0000fff0-0000-1000-8000-00805f9b34fb"
CHR_UUID = "0000fff1-0000-1000-8000-00805f9b34fb"
TARGET_RUNTIME = 1


# ---------------------------------------------------------------- framing

def encode(cmd: int, payload: bytes = b"") -> bytes:
    n = len(payload)
    body = bytes([cmd, n >> 8, n & 0xFF]) + payload
    return b"\x55\x7f" + body + bytes([sum(body) & 0xFF])


class Decoder:
    """Collect notify chunks and return complete frames as (cmd, payload)."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data: bytes):
        self.buf += data
        out = []
        while True:
            start = self.buf.find(b"\x55\x7f")
            if start < 0:
                self.buf.clear()
                return out
            del self.buf[:start]
            if len(self.buf) < 6:
                return out
            n = (self.buf[3] << 8) | self.buf[4]
            if len(self.buf) < 6 + n:
                return out
            frame = bytes(self.buf[:6 + n])
            del self.buf[:6 + n]
            if sum(frame[2:-1]) & 0xFF != frame[-1]:
                print(f"  ! bad checksum, frame dropped: {frame.hex()}")
                continue
            out.append((frame[2], frame[5:-1]))


# ---------------------------------------------------------------- image

def uid14(module_id: str) -> bytes:
    raw = bytes.fromhex(module_id.strip())
    if len(raw) != 12:
        sys.exit("module ID must be 24 hex characters")
    return raw[4:12] + raw[0:6]


def load_pages(path: str) -> list:
    data = open(path, "rb").read()
    if data.lstrip()[:1] == b"{":
        j = json.loads(data)
        if not j.get("success"):
            sys.exit(f"server JSON reports failure: {j.get('msg')}")
        pages = [bytes.fromhex(h) for h in j["hex"]]
    else:
        if len(data) % PAGE:
            sys.exit(f"file size {len(data)} is not a multiple of {PAGE}")
        pages = [data[i:i + PAGE] for i in range(0, len(data), PAGE)]
    return pages


def check_pages(pages: list) -> list:
    """Return a list of problems. An empty list means the image looks sane."""
    problems = []
    if not pages:
        return ["image has no pages"]
    if len(pages) > MAX_PAGES:
        problems.append(f"{len(pages)} pages is more than the slot holds ({MAX_PAGES})")
    for i, p in enumerate(pages):
        if len(p) != PAGE:
            problems.append(f"page {i}: {len(p)} bytes, expected {PAGE}")
        elif int.from_bytes(p[:2], "big") != i:
            problems.append(f"page {i}: index field is {int.from_bytes(p[:2], 'big')}")
    payload = b"".join(p[2:] for p in pages)
    value, count = Counter(payload).most_common(1)[0]
    if count > len(payload) * 0.5:
        problems.append(f"{count * 100 // len(payload)}% of the image is byte 0x{value:02x}: filler, not code")
    # The runtime starts with a RISC-V JAL x0 (opcode 0x6F) to its startup code.
    if payload[0] & 0x7F != 0x6F:
        problems.append(f"first instruction 0x{int.from_bytes(payload[:4], 'little'):08x} is not a jump")
    return problems


def describe(pages: list) -> None:
    payload = b"".join(p[2:] for p in pages)
    print(f"pages: {len(pages)}  payload: {len(payload)} bytes")
    for tag in (b"TSL6", b"CH32V20x_BLE_LIB"):
        print(f"  contains {tag.decode()!r}: {tag in payload}")


# ---------------------------------------------------------------- BLE

class Link:
    def __init__(self, client, chunk: int):
        self.client = client
        self.chunk = chunk
        self.dec = Decoder()
        self.q = asyncio.Queue()
        self.with_response = False

    async def start(self):
        char = self.client.services.get_characteristic(CHR_UUID)
        if char is None:
            sys.exit("characteristic FFF1 not found; is this a TSL module?")
        props = set(char.properties)
        self.with_response = "write" in props
        print(f"FFF1 properties: {sorted(props)}")
        await self.client.start_notify(CHR_UUID, self._on_notify)

    def _on_notify(self, _handle, data: bytearray):
        for frame in self.dec.feed(bytes(data)):
            self.q.put_nowait(frame)

    async def send(self, cmd: int, payload: bytes = b""):
        frame = encode(cmd, payload)
        for i in range(0, len(frame), self.chunk):
            await self.client.write_gatt_char(CHR_UUID, frame[i:i + self.chunk],
                                              response=self.with_response)

    async def request(self, cmd: int, payload: bytes, timeout: float, tries: int):
        for attempt in range(1, tries + 1):
            while not self.q.empty():
                self.q.get_nowait()
            await self.send(cmd, payload)
            try:
                while True:
                    rcmd, rpl = await asyncio.wait_for(self.q.get(), timeout)
                    if rcmd == cmd:
                        return rpl
                    print(f"  (ignored frame 0x{rcmd:02x} {rpl.hex()})")
            except asyncio.TimeoutError:
                print(f"  0x{cmd:02x}: no reply (try {attempt}/{tries})")
        return None


async def cmd_scan(_args):
    from bleak import BleakScanner
    found = await BleakScanner.discover(timeout=8.0, return_adv=True)
    for dev, adv in found.values():
        name = adv.local_name or dev.name or ""
        uuids = [u.lower() for u in adv.service_uuids]
        if SVC_UUID in uuids or any(k in name.upper() for k in ("TSL", "FFKJ")):
            print(f"{dev.address}  rssi={adv.rssi:4}  name={name!r}  services={uuids}")


async def cmd_status(args):
    from bleak import BleakClient
    async with BleakClient(args.address, timeout=20.0) as client:
        link = Link(client, args.chunk)
        await link.start()
        rpl = await link.request(0xA0, b"", timeout=2.0, tries=3)
        if rpl is None:
            print("no A0 reply")
        else:
            print(f"A0 reply ({len(rpl)} bytes): {rpl.hex()}")
            if len(rpl) >= 16:
                print(f"module ID field: {rpl[4:16].hex().upper()}")


async def cmd_flash(args):
    from bleak import BleakClient
    pages = load_pages(args.image)
    problems = check_pages(pages)
    if problems:
        print("image rejected:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    describe(pages)
    uid = uid14(args.id)
    if not args.yes:
        sys.exit("add --yes to write the image")

    async with BleakClient(args.address, timeout=20.0) as client:
        link = Link(client, args.chunk)
        await link.start()
        arg = bytes([TARGET_RUNTIME]) + uid

        rpl = await link.request(0x55, arg, timeout=2.0, tries=3)
        if rpl is None or (rpl and rpl[0] != 0):
            sys.exit(f"0x55 prepare failed (reply {rpl!r}). Wrong module ID, or not in boot mode")
        print("0x55 prepare: OK")

        rpl = await link.request(0x53, arg, timeout=3.0, tries=3)
        if rpl is None or (rpl and rpl[0] == 0xFF):
            sys.exit(f"0x53 start failed (reply {rpl!r})")
        print("0x53 start: OK, boot flag set to update mode")

        for i, page in enumerate(pages):
            rpl = await link.request(0x57, page, timeout=1.2, tries=10)
            if rpl is None:
                sys.exit(f"page {i} failed 10 times. The module stays in the bootloader. Retry the flash")
            print(f"\r0x57 page {i + 1}/{len(pages)}", end="", flush=True)
        print()

        rpl = await link.request(0x45, arg, timeout=3.0, tries=3)
        if rpl is None:
            sys.exit("0x45 finish: no reply. Power-cycle the module and check its state")
        print("0x45 finish: OK. The module now jumps to the new runtime")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chunk", type=int, default=20, help="bytes per BLE write (default 20)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan")
    c = sub.add_parser("check")
    c.add_argument("image")
    s = sub.add_parser("status")
    s.add_argument("address")
    f = sub.add_parser("flash")
    f.add_argument("address")
    f.add_argument("image")
    f.add_argument("--id", required=True, help="24-hex module ID from the app")
    f.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    if args.cmd == "check":
        pages = load_pages(args.image)
        describe(pages)
        problems = check_pages(pages)
        print("OK" if not problems else "REJECTED:\n  - " + "\n  - ".join(problems))
        sys.exit(1 if problems else 0)
    asyncio.run({"scan": cmd_scan, "status": cmd_status, "flash": cmd_flash}[args.cmd](args))


if __name__ == "__main__":
    main()
