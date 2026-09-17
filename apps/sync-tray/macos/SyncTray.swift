// SyncTray.swift — 同步状态菜单栏图标（macOS）
//
// 与 Windows 版（../windows/sync-tray.ps1）**能力面对齐**：
//   · 图标 = 循环双箭头（NSBezierPath 画的矢量弧线，不依赖 emoji 字体）
//   · 右下角标 = 状态：绿实心圆=正常 · 黄三角=有警告 · 红方块叉=有失败（形状+颜色双编码）
//   · 鼠标悬浮 → toolTip 两行：`同步正常 · 21:26（0 分钟前）` + 待办/引擎更新/无待办
//   · 菜单（**与 Windows 同一套，刻意保持短**）：
//       打开控制台 / 立即同步一次 / 引擎可更新(仅在落后时出现) / — /
//       随登录自启(勾选) / 状态变化时气泡提醒(勾选，默认关) / — / 退出
//     简报与日志都是控制台里的页，不再各占一项（Windows 侧 2026-09-17 同样精简）。
//   · 「检查并更新引擎」= 一键 fetch → pull --ff-only → 按改动面重注册调度 / 提示重编托盘
//     （落后时标题写「更新引擎（落后 N 个提交）」；网络调用带超时，绝不冻住菜单）
//   · CLI：--probe 打印真实状态与文案后退出（可测性，对应 Windows 的 -Probe）
//
// ⚠️ **本文件本轮改动未在 macOS 上编译验证**（作者机器无 Swift 工具链）。
//    上一轮的 5 处修复是 macOS 侧实测后回填的；**本轮新增部分请同样回填**：
//      · `bash build.sh --probe` 是否编译通过（swiftc 版本）
//      · --probe 输出的 state / tip 三行（tip 第二行在引擎落后时应显示「引擎可更新」）
//      · 菜单是否出现「打开控制台」，点了能否拉起控制台并打开浏览器
//      · 「状态变化时气泡提醒」勾选状态是否跨重启保留（flag 文件 sync/logs/.tray-balloon）
//    在此之前，本文件本轮改动的正确性状态是"未验证"，不要当成可用件（conventions §3 假绿防线）。
//
// 构建：bash build.sh          （产出 dist/SyncTray.app，ad-hoc 签名）
//       bash build.sh --install（顺便装到 /Applications）
import AppKit
import Foundation

let engineRoot = ProcessInfo.processInfo.environment["AI_SYNC_ENGINE"]
    ?? (NSHomeDirectory() as NSString).appendingPathComponent(".ai-sync/engine")
let instanceRoot: String = {
    if let env = ProcessInfo.processInfo.environment["AI_SYNC_INSTANCE"], !env.isEmpty { return env }
    let conv = (NSHomeDirectory() as NSString).appendingPathComponent(".ai-sync/instance")
    if FileManager.default.fileExists(atPath: (conv as NSString).appendingPathComponent("sync/instance.json")) { return conv }
    return engineRoot
}()
let statusTool = (engineRoot as NSString).appendingPathComponent("tools/sync-status.mjs")
let logDir = (instanceRoot as NSString).appendingPathComponent("sync/logs")
/// 气泡提醒开关：**默认关**（用户 2026-09-17 要求保持静默）。与 Windows 同一套 flag 文件。
let balloonFlag = (logDir as NSString).appendingPathComponent(".tray-balloon")

struct Brief {
    var ok = false
    var error = ""
    var state = "fail"
    var lastSyncAt = "?"
    var agoMin: Int? = nil
    var interval = 5
    var actions: [(String, String)] = []      // (source, text)
    var problems: [String] = []
    var machines: [(String, String, Int?, Int, Int)] = []   // (id, at, ageMin, rc, todos)
    var checkLines: [String] = []
    var engineRev: String? = nil
    var engineBehind: Int? = nil
}

/// 跑 `node sync-status.mjs --out <tmp>` 再按 UTF-8 读文件。
/// **不走管道**：这样完全不经过控制台编码（Windows 侧实测过同一类坑），macOS 上也更省心。
/// `fetch=false` 时加 `--no-fetch`（定时刷新用，避免每 2 分钟打一次网络）；
/// 用户**打开菜单**时用 `fetch=true` 复核一次 —— 否则"引擎是否落后"在 --no-fetch 下永远是未知。
func loadBrief(fetch: Bool = false) -> Brief {
    var b = Brief()
    guard FileManager.default.fileExists(atPath: statusTool) else { b.error = "缺 \(statusTool)"; return b }
    let tmp = NSTemporaryDirectory() + "ai-sync-brief-\(ProcessInfo.processInfo.processIdentifier).json"
    var parts: [String] = ["node", "'\(statusTool)'", "--instance", "'\(instanceRoot)'", "--out", "'\(tmp)'", "--quiet"]
    if !fetch { parts.append("--no-fetch") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")   // GUI 启动时 PATH 极小，必须经登录 shell 找 node
    p.arguments = ["-lc", parts.joined(separator: " ")]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { b.error = "无法启动 node：\(error.localizedDescription)"; return b }
    p.waitUntilExit()
    guard let data = FileManager.default.contents(atPath: tmp),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        b.error = "sync-status 未产出可解析的 JSON（退出码 \(p.terminationStatus)）"
        return b
    }
    try? FileManager.default.removeItem(atPath: tmp)
    b.ok = true
    b.state = (obj["state"] as? String) ?? "fail"
    b.lastSyncAt = (obj["lastSyncAt"] as? String) ?? "?"
    b.agoMin = obj["lastSyncAgoMin"] as? Int
    b.interval = (obj["intervalMinutes"] as? Int) ?? 5
    b.engineRev = obj["engineRev"] as? String
    b.engineBehind = obj["engineBehind"] as? Int
    for a in (obj["actions"] as? [[String: Any]]) ?? [] {
        b.actions.append(((a["source"] as? String) ?? "?", (a["text"] as? String) ?? ""))
    }
    b.problems = (obj["problems"] as? [String]) ?? []
    for m in (obj["machines"] as? [[String: Any]]) ?? [] {
        b.machines.append(((m["machine"] as? String) ?? "?",
                           (m["at"] as? String) ?? "?",
                           m["ageMin"] as? Int,
                           (m["rc"] as? Int) ?? -1,
                           ((m["actions"] as? [Any]) ?? []).count))
    }
    for c in (obj["checks"] as? [[String: Any]]) ?? [] {
        b.checkLines.append("[\((c["level"] as? String) ?? "?")] \((c["name"] as? String) ?? "?")  ← 期望 \((c["expected"] as? String) ?? "?") / 实际 \((c["actual"] as? String) ?? "?")")
    }
    return b
}

func tooltip(_ b: Brief) -> String {
    if !b.ok { return "同步状态不可用\n\(b.error)" }
    let ago = b.agoMin.map { "\($0) 分钟前" } ?? "刚刚"
    let head: String
    switch b.state {
    case "ok": head = "同步正常 · \(b.lastSyncAt)（\(ago)）"
    case "warn": head = "同步有提醒 · \(b.lastSyncAt)"
    default: head = "同步有失败 · \(b.lastSyncAt)"
    }
    let body: String
    if !b.actions.isEmpty {
        let items = b.actions.prefix(3).map { $0.1 }.joined(separator: "；")
        body = "待办 \(b.actions.count)：\(items)"
    } else if (b.engineBehind ?? 0) > 0 {
        // 引擎落后 ⇒ 说清楚"能更新"（否则只看到"有提醒"却不知道提醒什么）
        let n = b.engineBehind ?? 0
        body = "引擎可更新（落后 \(n) 个提交）→ 菜单里打开控制台看更新命令"
    } else if let first = b.problems.first {
        body = "问题 \(b.problems.count)：\(first)"
    } else {
        body = "无待办 · \(b.machines.count) 台机器已知"
    }
    return "\(head)\n\(body)"
}

/// 循环双箭头 + 右下角状态角标（矢量绘制；非模板图，避免被系统单色化后角标丢色）
func makeIcon(state: String) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size)
    img.lockFocus()
    let accent = NSColor.controlAccentColor
    accent.setStroke()
    let arc = NSBezierPath()
    arc.lineWidth = 2.0
    arc.lineCapStyle = .round
    // 两段弧
    arc.appendArc(withCenter: NSPoint(x: 9, y: 9), radius: 6, startAngle: 200, endAngle: 340)
    arc.appendArc(withCenter: NSPoint(x: 9, y: 9), radius: 6, startAngle: 20, endAngle: 160)
    arc.stroke()
    // 两个箭头
    for (x, y, dx) in [(14.5, 12.5, 1.0), (3.5, 5.5, -1.0)] {
        let tri = NSBezierPath()
        tri.move(to: NSPoint(x: x, y: y))
        tri.line(to: NSPoint(x: x + 3 * dx, y: y - 1.5))
        tri.line(to: NSPoint(x: x + 3 * dx, y: y + 1.5))
        tri.close()
        accent.setFill()
        tri.fill()
    }
    // 右下角标（形状 + 颜色双编码）
    let badgeColor: NSColor = state == "ok" ? .systemGreen : (state == "warn" ? .systemYellow : .systemRed)
    badgeColor.setFill()
    let r = NSRect(x: 11, y: 0.5, width: 6.5, height: 6.5)
    switch state {
    case "ok": NSBezierPath(ovalIn: r).fill()
    case "warn":
        let tri = NSBezierPath()
        tri.move(to: NSPoint(x: r.midX, y: r.maxY))
        tri.line(to: NSPoint(x: r.maxX, y: r.minY))
        tri.line(to: NSPoint(x: r.minX, y: r.minY))
        tri.close(); tri.fill()
    default:
        NSBezierPath(rect: r).fill()
        NSColor.white.setStroke()
        let x = NSBezierPath(); x.lineWidth = 1.2
        x.move(to: NSPoint(x: r.minX + 1.5, y: r.minY + 1.5)); x.line(to: NSPoint(x: r.maxX - 1.5, y: r.maxY - 1.5))
        x.move(to: NSPoint(x: r.maxX - 1.5, y: r.minY + 1.5)); x.line(to: NSPoint(x: r.minX + 1.5, y: r.maxY - 1.5))
        x.stroke()
    }
    img.unlockFocus()
    img.isTemplate = false
    return img
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var item: NSStatusItem!
    var timer: Timer?
    var lastState = ""
    var updateItem: NSMenuItem!
    var autostartItem: NSMenuItem!
    var balloonItem: NSMenuItem!

    func applicationDidFinishLaunching(_ note: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        buildMenu()
        refresh(balloon: false, fetch: true)
        timer = Timer.scheduledTimer(withTimeInterval: 120, repeats: true) { _ in self.refresh(balloon: true, fetch: false) }
    }

    func buildMenu() {
        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(NSMenuItem(title: "打开控制台", action: #selector(openConsole), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "立即同步一次", action: #selector(runTick), keyEquivalent: "s"))
        // 「引擎可更新（落后 N）」原先只是一条**只能看**的灰项；现在它本身就是一键更新入口
        updateItem = NSMenuItem(title: "检查并更新引擎", action: #selector(updateEngine), keyEquivalent: "u")
        menu.addItem(updateItem)
        menu.addItem(.separator())
        autostartItem = NSMenuItem(title: "随登录自启", action: #selector(toggleAutostart), keyEquivalent: "")
        menu.addItem(autostartItem)
        balloonItem = NSMenuItem(title: "状态变化时气泡提醒", action: #selector(toggleBalloon), keyEquivalent: "")
        menu.addItem(balloonItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
        syncCheckmarks()
    }

    /// 打开菜单时**复核一次**（带 fetch）：定时刷新走 --no-fetch 省网络，
    /// 但"引擎是否落后"必须有网络才看得准 —— 用户看菜单的这一刻是最合适的时机。
    func menuWillOpen(_ menu: NSMenu) {
        refresh(balloon: false, fetch: true)
    }

    func syncCheckmarks() {
        let plist = (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/cn.ai-sync.tray.plist")
        autostartItem.state = FileManager.default.fileExists(atPath: plist) ? .on : .off
        balloonItem.state = FileManager.default.fileExists(atPath: balloonFlag) ? .on : .off
    }

    @objc func refresh(balloon: Bool, fetch: Bool = false) {
        let b = loadBrief(fetch: fetch)
        let st = b.ok ? b.state : "fail"
        item.button?.image = makeIcon(state: st)
        item.button?.toolTip = tooltip(b)
        // 引擎更新入口：落后时标题直说落后几个提交，不落后就显示当前版本（与 Windows 托盘同款文案）
        let behind = b.engineBehind ?? 0
        if behind > 0 {
            updateItem.title = "更新引擎（落后 \(behind) 个提交）"
        } else if let rev = b.engineRev {
            updateItem.title = "检查并更新引擎（当前 \(rev)）"
        } else {
            updateItem.title = "检查并更新引擎"
        }
        let balloonOn = FileManager.default.fileExists(atPath: balloonFlag)
        if balloon && balloonOn && st != "ok" && st != lastState {
            // 只在**开关打开**且状态跳变时提示一次（默认关：用户要求静默；否则每 2 分钟骚扰）
            let n = NSUserNotification()
            n.title = "ai-sync 同步"
            n.informativeText = tooltip(b)
            NSUserNotificationCenter.default.deliver(n)
        }
        lastState = st
        syncCheckmarks()
    }

    @objc func toggleBalloon() {
        let fm = FileManager.default
        if fm.fileExists(atPath: balloonFlag) {
            try? fm.removeItem(atPath: balloonFlag)
        } else {
            try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)
            try? "on".write(toFile: balloonFlag, atomically: true, encoding: .utf8)
        }
        syncCheckmarks()
    }

    /// 打开控制台：没在跑就先拉起（与 Windows 的 Open-Console 同一套语义），再开浏览器。
    /// 端口取 sync/instance.json 的 console.port（默认 7788）。
    @objc func openConsole() {
        let port = consolePort()
        let alive = shell("/usr/bin/curl", ["-s", "-o", "/dev/null", "-m", "1", "http://127.0.0.1:\(port)/api/status"]) == 0
        if !alive {
            let srv = (engineRoot as NSString).appendingPathComponent("apps/sync-console/server.mjs")
            guard FileManager.default.fileExists(atPath: srv) else {
                alert("找不到控制台服务：\(srv)")
                return
            }
            // 显式传引擎/实例根：控制台据此判断"引擎是否落后"，不传会退化成"原地布局"而永远报未知
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = ["-lc", "AI_SYNC_ENGINE='\(engineRoot)' AI_SYNC_INSTANCE='\(instanceRoot)' nohup node '\(srv)' --instance '\(instanceRoot)' --port \(port) >/dev/null 2>&1 &"]
            try? p.run()
            Thread.sleep(forTimeInterval: 1.5)
        }
        if let u = URL(string: "http://127.0.0.1:\(port)/") { NSWorkspace.shared.open(u) }
    }

    func consolePort() -> Int {
        let f = (instanceRoot as NSString).appendingPathComponent("sync/instance.json")
        if let d = FileManager.default.contents(atPath: f),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let c = o["console"] as? [String: Any],
           let p = c["port"] as? Int { return p }
        return 7788
    }

    @objc func runTick() {
        let tick = (engineRoot as NSString).appendingPathComponent("tools/sync-tick.mjs")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "node '\(tick)' --instance '\(instanceRoot)' --no-jitter"]
        try? p.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.refresh(balloon: false, fetch: false) }
    }

    /// 跑一条 git 命令（带**超时**：菜单一点就把 UI 冻住是不可接受的；实测 Windows 侧无超时那版卡到 600s）。
    func gitRun(_ args: [String], _ seconds: Double) -> (Int32, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "git -C '\(engineRoot)' " + args.joined(separator: " ")]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, "无法启动 git：\(error.localizedDescription)") }
        let deadline = Date().addingTimeInterval(seconds)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
        if p.isRunning {
            p.terminate()
            let s = Int(seconds)
            return (124, "超时（\(s)s 未返回，已终止）")
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return (p.terminationStatus, text)
    }

    /// 一键更新引擎（与 Windows 托盘同一套语义）：fetch → 落后判定 → pull --ff-only →
    /// 安装器有变则重注册调度；托盘自身有变则提示重编（macOS 上不能自重建 App）。
    @objc func updateEngine() {
        var steps: [String] = []
        let (brc, brRaw) = gitRun(["rev-parse", "--abbrev-ref", "HEAD"], 15)
        let branch = brRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        if brc != 0 || branch.isEmpty || branch == "HEAD" {
            alert("更新失败（未做任何改动）\n\n引擎不在分支上：\n\(brRaw)")
            return
        }
        let (_, beforeRaw) = gitRun(["rev-parse", "--short", "HEAD"], 15)
        let before = beforeRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        // 低速阈值：防"连上了但永远不动"把菜单拖住
        let (fc, fout) = gitRun(["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=20", "fetch", "--quiet", "origin", branch], 45)
        if fc != 0 {
            alert("更新失败（未做任何改动）\n\ngit fetch 失败：\n\(fout)")
            return
        }
        let (_, behindRaw) = gitRun(["rev-list", "--count", "HEAD..origin/\(branch)"], 15)
        let behind = Int(behindRaw.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        var changed = ""
        if behind > 0 {
            let (pc, pout) = gitRun(["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=20", "pull", "--ff-only"], 90)
            if pc != 0 {
                alert("更新失败（未做任何改动）\n\ngit pull --ff-only 失败（本地有分叉或未提交改动？）：\n\(pout)")
                return
            }
            steps.append("拉取 \(behind) 个提交")
            let (_, c) = gitRun(["diff", "--name-only", before, "HEAD"], 20)
            changed = c
            if c.contains("install/") {
                let srv = (engineRoot as NSString).appendingPathComponent("install/install.mjs")
                let rc2 = shell("/bin/zsh", ["-lc", "node '\(srv)' --instance '\(instanceRoot)' --register"])
                if rc2 == 0 { steps.append("安装器有变 → 已重注册调度") }
                else {
                    let code = Int(rc2)
                    steps.append("安装器有变，但重注册失败（exit \(code)）")
                }
            }
            if c.contains("apps/sync-tray/") {
                steps.append("托盘自身有更新 → 请重编：bash '\(engineRoot)/apps/sync-tray/macos/build.sh' --install")
            }
            if !c.contains("install/") && !c.contains("apps/sync-tray/") {
                steps.append("工具/适配器/文档有更新 → 下一轮 tick 自动生效")
            }
        } else {
            steps.append("已是最新，无需拉取")
        }
        let (_, afterRaw) = gitRun(["rev-parse", "--short", "HEAD"], 15)
        let after = afterRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        var msg = behind > 0 ? "引擎已更新：\(before) → \(after)" : "引擎已是最新：\(after)"
        msg += "\n分支：\(branch)    目录：\(engineRoot)\n\n"
        msg += steps.map { "· " + $0 }.joined(separator: "\n")
        alert(msg)
        refresh(balloon: false, fetch: true)
    }

    @objc func toggleAutostart() {
        let plist = (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/cn.ai-sync.tray.plist")
        let fm = FileManager.default
        if fm.fileExists(atPath: plist) {
            _ = shell("/bin/launchctl", ["bootout", "gui/\(getuid())/cn.ai-sync.tray"])
            try? fm.removeItem(atPath: plist)
        } else {
            let exe = Bundle.main.executablePath ?? ""
            let xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0"><dict>
              <key>Label</key><string>cn.ai-sync.tray</string>
              <key>ProgramArguments</key><array><string>\(exe)</string></array>
              <key>RunAtLoad</key><true/>
            </dict></plist>
            """
            try? xml.write(toFile: plist, atomically: true, encoding: .utf8)
            _ = shell("/bin/launchctl", ["bootstrap", "gui/\(getuid())", plist])
        }
        syncCheckmarks()
        refresh(balloon: false, fetch: false)
    }

    func alert(_ msg: String) {
        let a = NSAlert()
        a.messageText = "ai-sync"
        a.informativeText = msg
        a.runModal()
    }

    static func dayStamp() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd"; return f.string(from: Date())
    }

    func shell(_ path: String, _ args: [String]) -> Int32 {
        let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
        try? p.run(); p.waitUntilExit(); return p.terminationStatus
    }
}

// CLI：--probe（可测性，对应 Windows 的 -Probe）
if CommandLine.arguments.contains("--probe") {
    let b = loadBrief(fetch: true)
    print("state=\(b.ok ? b.state : "fail")  ok=\(b.ok)")
    print("lastSyncAt=\(b.lastSyncAt)  agoMin=\(b.agoMin.map(String.init) ?? "-")  interval=\(b.interval)")
    print("engineRev=\(b.engineRev ?? "-")  engineBehind=\(b.engineBehind.map(String.init) ?? "-")")
    print("actions=\(b.actions.count)")
    print("tip:")
    for line in tooltip(b).split(separator: "\n") { print("  |\(line)") }
    for st in ["ok", "warn", "fail"] { _ = makeIcon(state: st) }
    print("icons: ok/warn/fail 已生成")
    let balloonOn = FileManager.default.fileExists(atPath: balloonFlag)
    print("balloon=\(balloonOn ? "on" : "off（默认静默）")")
    print("menu: 打开控制台 / 立即同步一次 / 引擎可更新(仅落后时) / — / 随登录自启(勾选) / 状态变化时气泡提醒(勾选，默认关) / — / 退出")
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)     // 无 Dock 图标
app.run()
