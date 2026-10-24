# 免责声明 / Disclaimer

本项目 **perchai-openai-adapter**（以下简称“本项目”）是一个在本地运行的非官方适配器，
用于把你自己已登录的 Perch Web 会话包装成 OpenAI 兼容接口。使用前请完整阅读本声明。

## 1. 非官方、无关联

本项目由个人开发者维护，**与 Perch AI 及其关联公司没有任何隶属、授权、合作或背书关系**。
“Perch”“Perch AI”等名称、商标、服务与内容归其各自权利人所有。本项目仅出于互操作目的使用公开可见的
网络接口，不代表上游认可或支持本项目。

## 2. 账号与凭据由你自行负责

- 本项目需要你提供自己的 Perch 登录 Cookie / Supabase 会话。凭据只保存在本机 `data/` 目录
  （`state.json`、`accounts.json`，权限 0600），不会由本项目主动上传到第三方。
- 请勿把 `data/`、Cookie、token 或号池文件提交到公开仓库、发给他人或放进截图。
- 你应确保自己有权使用这些账号，并对账号下发生的一切行为负责。

## 3. 遵守上游服务条款

- 你必须自行遵守 Perch AI 的服务条款、使用政策、套餐限制和当地法律。
- 本项目不会、也不应被用于绕过付费墙、套餐限制、速率限制、地区限制或其他访问控制。
- 本项目定位是“让自己的 Web 会话在别的客户端里可用”，**不是**对外提供 API 转售、代充、
  共享账号或规避上游计费的工具。
- 上游可能随时调整协议、限流、封禁账号或终止相关接口。本项目不保证任何接口长期可用。

## 4. 无担保

本项目按“现状”（AS IS）提供，不附带任何明示或默示的担保，包括但不限于适销性、
特定用途适用性、不侵权、无中断或无错误。上游返回的内容、模型身份、用量统计均由上游提供，
本项目不构成对它们的真实性、准确性或可用性的保证。

## 5. 使用风险

使用本项目可能导致账号被限流、临时封禁或永久封禁，也可能产生套餐费用或额度消耗。
你应自行评估风险，先用小号或测试账号验证。因使用或无法使用本项目造成的任何直接或间接损失，
包括数据丢失、账号损失、费用、业务中断或第三方索赔，作者与贡献者不承担责任。

## 6. 许可证范围

- 本仓库中的**源代码**采用 [MIT License](LICENSE)。
- MIT 许可**不覆盖** Perch AI 的服务、接口、模型、商标、内容，也不覆盖通过 npm 安装的第三方依赖；
  这些内容各自受其权利人的条款与许可证约束（例如 `perchai-cli` 随包附带的 LICENSE）。
- 本项目不附带、不转授任何上游数据或模型的权利。

## 7. 其他

- 本声明不构成法律建议。若你计划商用、对外分发或用于受监管场景，请自行咨询专业律师。
- 作者可随时更新本声明；继续使用即视为接受更新后的版本。

---

**English summary:** This is an unofficial, local-only adapter with no affiliation
with Perch AI. You supply your own credentials; you are responsible for complying
with the upstream terms, plan limits and applicable law. The software is provided
"as is", without warranty, and the authors are not liable for account restrictions,
charges, data loss or any other damages. The MIT license covers this repository's
source code only, not Perch AI's services, models, trademarks or third-party
dependencies.
