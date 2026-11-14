// Change BLE password (vendor: the 修改密码 form on the settings page). Sends A9.
import { h, L, section, btn, toast, confirmBox, alertBox } from "../ui.js";
import { S, definePage, ask, back } from "../app.js";
import { buildA9, validatePasswordChange, decodeA9Reply } from "../../lib/tsl6-status.js";

definePage("password", () => {
  const input = ph => h("input", { class: "text mono", type: "text", maxlength: 4, placeholder: ph, autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false" });
  const oldI = input(L("Old password", "原密码"));
  const newI = input(L("New password (letters, digits, symbols)", "新密码 (字母, 数字, 英文符号)"));
  const conI = input(L("Confirm new password", "确认新密码"));

  async function submit() {
    if (!S.status || S.blank) return toast(L("Enter the BLE password first.", "请先输入蓝牙密码"), "warn");
    const err = validatePasswordChange(oldI.value, newI.value, conI.value);
    if (err) return toast(L(err.en, err.zh || err.en), "bad", 2500);
    let c;
    try { c = buildA9(S.status, oldI.value, newI.value); } catch (e) { return toast(e.message, "bad", 3000); }
    const r = await ask(c.type, c.payload, { confirm: { en: "Change the password?", zh: "确定要修改密码吗？" }, timeout: 3000 });
    if (!r) return;
    const res = decodeA9Reply(r.payload);
    if (!res.ok) return alertBox(L(res.en, res.zh || res.en));
    // The vendor keeps the old saved key here. We save the new one, so the next connection logs in.
    try { localStorage.setItem(`tsl6.key.${S.link.id}`, newI.value); } catch { /* storage blocked */ }
    await alertBox(L(`Password changed. Keep it: ${newI.value}`, `密码修改成功。请牢记新密码：${newI.value}`));
    S.link.readStatus().catch(() => {});
    back();
  }

  const el = h("div", { class: "page" }, section({ en: "Change BLE password (default: 1234)", zh: "修改蓝牙密码 (默认:1234)" },
    h("div", { class: "form" }, oldI, newI, conI, h("div", null, btn({ en: "Change password", zh: "确认修改" }, submit, { kind: "primary" })))),
  h("p", { class: "foot" }, L(
    "Use 4 printable characters. If you forget the new password, you cannot change settings until you reflash the module.",
    "请使用4位可打印字符。忘记新密码后，需重新刷写模块才能修改设置。")));
  return { el, title: { en: "Change password", zh: "修改密码" } };
});
