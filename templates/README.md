# 测试用例模板

`test-cases.xlsx` 是 Auto-Test MVP 的标准输入模板。

`environment-profiles.example.json` 是无人值守任务的环境注册表示例。Linux/macOS 的 Registry 默认放在 `~/.config/auto-test/environment-profiles.json`，Windows 默认放在 `%APPDATA%\auto-test\environment-profiles.json`。模板内的私有文件路径相对 Registry 解析，不得提交认证状态文件。

规则：

- 不要调整必填列名称；
- 一条用例占一行；
- `测试步骤` 和 `预期结果` 中一行写一个动作或断言；
- 真实密码使用 `${secret:profile.key}` 引用；
- 有写入或删除行为时填写正确的 `风险等级` 和 `清理步骤`；
- 运行前系统会先输出导入诊断，不会直接操作网站。
