# TSL6 Web BLE Recovery

A Web Bluetooth page that recovers a TSL6 (Feifan Commander 6th gen) autopilot module that is stuck in its bootloader.

**Live page:** https://tsl6-recovery.surge.sh/

> Use at your own risk. This project is not affiliated with the module maker, its resellers, or Tesla. Work only while the car is parked.

## The problem

After a failed OTA, the module advertises as `TSL6-BOOT`. The vendor Mini App flashes it to 100%. The module reboots, the app reports "init mode", and the loop starts again.

One known cause: for some module IDs, the vendor update server (`iffrc.com/ffkj/user/ble.php`, `fun=update`) replies `success: true` but sends 10 pages of the byte `0x31` ("1111…") instead of firmware. The bootloader writes this filler to the app slot and jumps to it. The app crashes, and the module returns to the bootloader.

## What the page does

1. Connects to `TSL6-BOOT` over BLE (service `FFF0`, characteristic `FFF1`).
2. Reads the module status (`0xA0`). This step is read-only. It fills in the module ID.
3. Loads a runtime image and checks it:
   - The page indices are correct.
   - The image is not filler (no byte value fills more than 50%).
   - The first instruction is a RISC-V jump.
4. Writes the image with the bootloader update commands:

| Command | Payload | Bootloader action |
|---|---|---|
| `0x55` prepare | `01` + UID14 | Checks the UID |
| `0x53` start | `01` + UID14 | Accepts target `01` (runtime) only. Sets the boot flag to update mode |
| `0x57` page | one 1026-byte page | Erases, writes, and reads back 1 KiB at `0x08008000 + index × 0x400`. No reply = the read-back failed |
| `0x45` finish | `01` + UID14 | Drops BLE after 200 ms. Jumps to the app after 400 ms |

Frame format: `55 7F TYPE LEN_H LEN_L PAYLOAD CHK`, where `CHK = (TYPE + LEN_H + LEN_L + sum(PAYLOAD)) & 0xFF`.

`UID14 = module_id[4:12] + module_id[0:6]`. The module ID is the 12-byte chip UID at `0x1FFFF7E8`. The app shows it as 24 hex characters.

## Why it is low-risk

- The bootloader write handler accepts only addresses `0x08008000`–`0x0801FF00` (the app slot). It cannot overwrite itself over BLE.
- Settings, BLE pairings, and the activation code are in `0x08077800`–`0x08077FFF`. A flash does not touch them.
- If a flash fails, the module stays in the bootloader. You can try again.

## Steps

1. Keep the car awake (climate or Camp mode on).
2. Turn off Bluetooth on any phone that has the vendor Mini App.
3. Open the page:
   - Android or desktop: Chrome or Edge.
   - iPhone: the Bluefy browser (App Store: "Bluefy – Web BLE Browser"). Safari and Firefox have no Web Bluetooth.
4. Tap **Connect** and pick `TSL6-BOOT`.
5. Tap **Read status**. Check the module ID.
6. Tap **Load June 2026 dump**. It must show **Image OK**.
7. Tick the confirm box. Tap **Flash runtime**. 72 pages take about 5–6 minutes in Bluefy.
8. Unplug the module for 10 s, then plug it in. It must advertise as `TSL6`, not `TSL6-BOOT`.

**After recovery, do not run an update from the vendor Mini App.** The server can send the filler image again.

## Firmware image

`public/runtime.bin` is the runtime image from [LQCross/TSL6-Firmware](https://github.com/LQCross/TSL6-Firmware). It was downloaded from the vendor server in June 2026. The app reported it as runtime V1.0.00 with boot V1.2.00.

- Transport format: 72 pages × 1026 bytes (2-byte big-endian page index + 1024 bytes of code).
- SHA-256: `b1b2a3aa5e71d88336719bccb5da822faffc05acf50b5b482e570f1981dabbd5`.

It recovered a TSL6 in a 2023 Model Y (boot reply `00 12 10 00`, which is likely boot V1.2). It is not the newer 4.1.60 build.

## Python version

`tools/tsl6_ble_flash.py` does the same steps from a laptop. It needs `pip install bleak`. It is not yet tested on hardware.

```sh
python3 tools/tsl6_ble_flash.py scan
python3 tools/tsl6_ble_flash.py check public/runtime.bin
python3 tools/tsl6_ble_flash.py status <ADDRESS>
python3 tools/tsl6_ble_flash.py flash <ADDRESS> public/runtime.bin --id <24-HEX-MODULE-ID> --yes
```

## Deploy

```sh
surge public tsl6-recovery.surge.sh
```

## Notes for browsers

- Bluefy does not give characteristic `properties`. The page then uses `FFF1` for both receive and send.
- iOS rejects self-signed certificates without a bypass. Use a trusted HTTPS host.
