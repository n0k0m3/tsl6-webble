// Bluetooth tab (vendor pages/ble). Web Bluetooth has no scan list: the browser shows its own device chooser.
import { h, L, row, section, btn, icon, toast, clear, picker, helpButton } from "../ui.js";
import { S, definePage, onBus, connect, disconnect, askPassword } from "../app.js";
import { WebLink, platformChunk, SAFE_CHUNK } from "../ble.js";

definePage("connect", () => {
  const el = h("div", { class: "page" });
  let all = false;

  function render() {
    clear(el);
    const link = S.link;
    const on = link && link.connected;
    const supported = S.mock || WebLink.available();
    const head = h("div", { class: "toolbar" },
      h("div", { class: "row-left" }, h("span", { class: "row-label", style: { color: "var(--mint-d)" } },
        on ? L("Connected", "已连接") : L("Bluetooth", "蓝牙")), helpButton("help_ble", { en: "Bluetooth", zh: "蓝牙" })),
      on ? btn({ en: "Disconnect", zh: "断开" }, () => disconnect(), { kind: "small" })
        : btn({ en: "Search", zh: "搜索蓝牙" }, () => connect({ all }), { kind: "small primary", disabled: !supported }));
    const card = h("section", { class: "card" }, head);
    if (on) {
      card.append(h("div", { class: "row" },
        h("div", { class: "row-left" }, h("span", { style: { color: "#3b82f6" } }, icon("ble", 26)),
          h("div", null, h("div", { class: "row-label", style: { color: "var(--mint-d)" } }, link.name),
            h("div", { class: "row-note mono" }, S.mock ? "mock" : L("Paired in this browser", "已在此浏览器配对")))),
        h("span", { class: "kv" }, link.authed ? L("Password OK", "密码已验证") : L("No password yet", "未验证密码"))));
      card.append(h("div", { class: "row" },
        h("div", { class: "row-left" }, h("span", { class: "row-label" }, L("Module reply", "模块应答"))),
        h("span", { class: "kv" }, S.status ? L(`status received (${S.status.length} bytes)`, `已收到状态（${S.status.length} 字节）`) : L("no reply yet", "尚无应答"))));
      if (!link.authed) card.append(h("div", { class: "row" },
        h("div", { class: "row-left" }, h("span", { class: "row-label" }, L("BLE password", "蓝牙密码"))),
        btn({ en: "Enter password", zh: "输入密码" }, () => askPassword("manual"), { kind: "small primary" })));
    } else if (!supported) {
      card.append(h("p", { class: "empty" }, L(
        "This browser has no Web Bluetooth. Use Chrome or Edge on Android or a computer. On iPhone, use the Bluefy browser.",
        "此浏览器不支持网页蓝牙。请在安卓或电脑上使用 Chrome / Edge，iPhone 请使用 Bluefy 浏览器。")));
    } else {
      card.append(h("p", { class: "empty" }, L(
        "Tap Search. The browser shows a list of nearby modules (TSL…). Pick yours.",
        "点击「搜索蓝牙」，浏览器会列出附近的模块（TSL…），选择您的模块。")));
    }
    el.append(card);

    if (!on) {
      el.append(section(null,
        row({ en: "Show all devices", zh: "显示所有设备" }, { note: L("if the module does not appear", "找不到模块时使用") },
          (() => { const c = h("input", { type: "checkbox", checked: all }); c.addEventListener("change", () => { all = c.checked; }); return c; })())));
    }
    el.append(section({ en: "Before you connect", zh: "连接前" },
      h("div", { class: "form" },
        h("p", { style: { margin: 0 } }, L("1. Keep the car awake (climate or Camp mode on).", "1. 保持车辆唤醒（打开空调或露营模式）。")),
        h("p", { style: { margin: 0 } }, L("2. The module accepts one connection at a time. Close the vendor Mini App, or turn off Bluetooth on that phone.",
          "2. 模块同一时间只接受一个连接。请关闭原厂小程序，或关闭该手机的蓝牙。")),
        h("p", { style: { margin: 0 } }, L("3. The default BLE password is 1234.", "3. 默认蓝牙密码为 1234。")))));
    if (on) {
      const sizes = [[platformChunk(), L(`${platformChunk()} bytes (default)`, `${platformChunk()} 字节（默认）`)], [SAFE_CHUNK, L("20 bytes (safe, slow)", "20 字节（稳定，较慢）")]];
      el.append(section({ en: "Link", zh: "连接参数" },
        row({ en: "Bytes per BLE write", zh: "每次写入字节数" }, { note: L("drops to 20 after a write error", "写入出错时自动降为20") },
          picker({ value: link.chunk, options: sizes, onchange: v => { link.setChunk(v); toast(L("Saved", "已保存"), "ok"); } })),
        row({ en: "Read status", zh: "读取状态" }, {}, btn({ en: "Read", zh: "读取" }, async () => {
          const p = await link.readStatus().catch(() => null);
          toast(p ? L("Status read", "读取成功") : L("No reply from the module.", "模块无应答"), p ? "ok" : "warn");
        }, { kind: "small" }))));
    }
  }

  const offs = [];
  render();
  return {
    el,
    enter() { offs.push(onBus("conn", render)); offs.push(onBus("status", render)); },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
