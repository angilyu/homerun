const { invoke } = window.__TAURI__.core;
const out = document.getElementById("out");
const show = (v) => (out.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2));
const call = (cmd, args) => invoke(cmd, args).then(show, (e) => show(`error: ${e}`));

document.querySelectorAll("[data-rt]").forEach((b) => (b.onclick = () => call("rt_call", { method: b.dataset.rt, params: {} })));
document.querySelectorAll("[data-login]").forEach((b) => (b.onclick = () => call("login_item", { action: b.dataset.login })));
document.getElementById("update").onclick = () => call("update_now");
document.getElementById("run").onclick = () =>
  call("rt_call", { method: "run.start", params: { prompt: document.getElementById("prompt").value } });
