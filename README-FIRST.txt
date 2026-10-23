================================================
  CF 优选 IP —— 快速上手（拿到文件夹先看这个）
================================================

【第 1 步】装 Node.js
  到 https://nodejs.org/zh-cn/download 下载 LTS 版，一路"下一步"装完。
  装完双击 run-fast.cmd 若还提示找不到 Node，重启一次电脑即可。
  （项目只需要这一个依赖，其余都是 Windows 自带）


【第 2 步】先看效果（可选，0 配置）
  什么都不用填，直接双击 run-fast.cmd
  程序会自动进入"演示模式"：只测速、打印排名，十几秒出结果，
  绝不会碰你的 DNS。


【第 3 步】填你自己的配置
  1) 把 user.config.jsonc.example 改名为  user.config.jsonc
     （提示：Windows 默认隐藏扩展名，改名时别变成 user.config.jsonc.example.txt。
       建议先在资源管理器"查看"里勾选"文件扩展名"）
  2) 用记事本打开它，填三处（每项旁边都有中文说明）：
     · apiToken —— Cloudflare API Token
                   获取：dash.cloudflare.com → 头像 → My Profile → API Tokens
                   权限只需 Zone → DNS → Edit，建议限定到具体域名
     · zoneId   —— 该域名的 Zone ID
                   获取：dash.cloudflare.com 点进域名 → 右下角 Overview 面板
     · records  —— 要自动替换的子域名，改成你自己的，例如 sub.你的域名.com

  安全提示：apiToken / zoneId / records 任意一项留空，程序就只测速不上传。
            想随时停掉上传，把 apiToken 清空即可。


【第 4 步】正式运行
  双击 run-fast.cmd   ← 日常用：先体检现有 IP，达标几秒收工；不达标才重新优选
  双击 run-full.cmd   ← 想挖最快的节点时用：全量测速，6-8 分钟

  （可选）双击 make-desktop-shortcuts.cmd，把这两个放到桌面


【第 5 步】看结果 / 回滚
  logs\latest.log  —— 最近一次运行的完整日志（只保留最近 3 次）
  backups\         —— 每次改动 DNS 之前的完整备份，可据此回滚


【第 6 步】想定时自动跑（可选）
  用 Windows「任务计划程序」定时执行：
      <Node 路径>  src\cfip-fast.mjs
  "起始于"填本文件夹路径。
  建议设在 19:00-23:00（大陆上网高峰），这样选出来的 IP 高峰期也好用。


【文件夹结构说明】
  根目录只放你会直接用的东西：
      run-fast.cmd          ← 日常运行（双击）
      run-full.cmd          ← 全量运行（双击）
      run-cfip.cmd          ← 命令行入口，可加参数
      make-desktop-shortcuts.cmd  ← 建桌面图标
      user.config.jsonc     ← 你的配置（由 .example 改名而来）
      README-FIRST.txt / README-AUTO.md  ← 说明文档

  程序文件都在 src\ 里，不用管它：
      cfip-fast.mjs / cfip-auto.mjs / cfip-lib.mjs / cf-api.mjs
      cfip.config.json          ← 内置默认参数
      make-desktop-shortcuts.ps1

  var\ 是运行产物，删掉也不影响使用（下次运行自动重建）：
      var\logs\        运行日志（保留最近 3 次）
      var\backups\     DNS 记录备份（保留最近 3 份，可回滚）
      var\cache\       订阅缓存、测速历史


【常见问题】
  · 提示找不到 Node.js
      没安装，或装了没重启。装 LTS 版后重启电脑即可。
  · 改完配置怎么生效
      保存文件即可，下次运行自动读取，不需要重启任何东西。
  · 提示"上游已 XXX 小时未更新"
      订阅源本身很久没更新了，不影响使用——程序会自己实测筛掉失效节点。
  · 测出来的速度和标注差很多
      正常。上游标注是别人测的，而且时间久远；本程序一律以你本地实测为准。
  · 想换订阅源
      改 user.config.jsonc 里的 source.urls，可填多个，会自动合并去重。
  · 为什么运行后根目录没变多文件
      所有运行日志与备份都写进 var\ 了，根目录保持整洁。

更完整的技术说明（两种方案的原理、全部参数、退出码）见 README-AUTO.md
