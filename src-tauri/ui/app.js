const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;
const open = window.__TAURI__?.dialog?.open;
const $ = id => document.getElementById(id);
const log = text => { $('log').textContent += `\n${text}`; $('log').scrollTop = $('log').scrollHeight; };
if (listen) { listen('run-output', e => log(e.payload)); listen('run-finished', () => { $('state').textContent = '已完成'; $('start').disabled = false; $('stop').disabled = true; }); }
$('clear').onclick = () => { $('log').textContent = '等待开始…'; };
$('choose').onclick = async () => { const path = open ? await open({ multiple: false, filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }] }) : null; if (typeof path === 'string') { $('choose').dataset.path = path; $('filename').textContent = path.split(/[\\/]/).pop(); } };
$('start').onclick = async () => { const file = $('choose').dataset.path; const urls = $('urls').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean); if (!file || !urls.length) return alert('请选择 Excel 并填写至少一个 URL。'); $('log').textContent = '正在启动…'; $('state').textContent = '运行中'; $('start').disabled = true; $('stop').disabled = false; try { await invoke('run_test', { request: { file, urls, one: $('one').checked } }); } catch (e) { log(`启动失败：${e}`); $('state').textContent = '失败'; $('start').disabled = false; $('stop').disabled = true; } };
$('stop').onclick = async () => { await invoke('stop_test'); $('state').textContent = '已停止'; $('start').disabled = false; $('stop').disabled = true; };
