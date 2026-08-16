# Windows Tauri 图形包

仓库现在包含一个最小 Tauri 2 桌面入口：`src-tauri/`。它只负责选择 Excel、填写 URL、启动现有 `Auto-Test.cmd run` 并显示标准输出；API Key、DPAPI、便携 Node/Codex、Chromium、运行目录和结果合同仍由 Windows 启动器负责。

这是 GUI 外壳，不是第二套执行引擎，避免图形入口和命令行入口产生不同的认证、恢复或安全语义。

## 本地构建

需要 Windows、Rust stable、WebView2 和 Tauri CLI。当前 Linux/WSL 构建环境没有 Rust 工具链，未在此处声称已生成 Windows 安装器。

在仓库根目录执行：

```powershell
npm install
cargo install tauri-cli --version '^2'
cargo tauri build --manifest-path src-tauri/Cargo.toml
```

构建前，`Auto-Test.cmd`、`scripts/`、编译后的 `dist/`、`package.json` 和依赖必须作为 Tauri bundle resources 一起交付；当前私有 ZIP 仍是已验证的 CLI 发行格式。GUI 包在 Windows 上完成 `--setup-only`、`doctor`、一条 `--one` canary，并核对 `codex-agent.result.json`、证据和 Mutation Ledger 后，才能宣称业务通过。

GUI 不会自动保存 Excel、URL 或 API Key。结果仍按启动器规则写入 `%LOCALAPPDATA%\\auto-test\\runs`。
