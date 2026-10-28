# Starforest 真实外卖 MCP

这是 `sanqianzilanyue/ai-order-takeout` 与 Starforest 之间的桥接层。上游脚本保留在用户电脑，账号 Cookie、完整地址、手机号和支付口令不会进入小手机导入文件。

## Windows 安装

1. PowerShell 运行 `setup.ps1`。第一次会打开 `places.local.json`，填写地址坐标、地址簿识别词和手机号后保存，再运行一次。
2. 在弹出的专用 Chrome/Edge 中打开 `https://h5.ele.me` 并扫码登录。
3. 运行 `start.ps1`，保持窗口开启。
4. 在 Starforest：设置 → 聊天工具箱 → 右上角菜单 → 导入工具，选择 `%USERPROFILE%\Starforest-Takeout\starforest-takeout-tool.json`。
5. 打开“真实外卖助手”，点“发现工具”，确认启用。

Char 调用“准备真实外卖订单”后，电脑上的 worker 先用上游 dry 模式试算店铺、商品和结算金额，不会提交订单或付款；试算信息回到聊天后显示独立确认卡。只有用户核对具体商品和金额并点击“确认下单”，worker 才会再次运行真实下单脚本。验证码、人机验证、登录失效和平台风控必须由用户在专用浏览器中处理。

支付密码如确需自动填写，只能由用户自行保存到 `%USERPROFILE%\.takeout_pay`，不要写进 JSON、MCP 配置、Git 仓库或聊天消息。默认不创建该文件，脚本遇到支付密码会停下。
