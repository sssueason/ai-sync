// SyncTray.swift — 同步状态菜单栏图标（macOS）
//
// 与 Windows 版（../windows/sync-tray.ps1）**能力面对齐**：
//   · 图标 = 循环双箭头（NSBezierPath 画的矢量弧线，不依赖 emoji 字体）
//   · 右下角标 = 状态：绿实心圆=正常 · 黄三角=有警告 · 红方块叉=有失败（形状+颜色双编码）
//   · 鼠标悬浮 → toolTip 两行：`同步正常 · 21:26（0 分钟前）` + `待办 2：…`
//   · 菜单：简报… / 立即同步 / 打开日志 / 随登录自启 / 退出
//   · CLI：--probe 打印真实状态与文案后退出（可测性，对应 Windows 的 -Probe）
//
// ⚠️ **本文件尚未在 macOS 上编译验证**（作者机器无 Swift 工具链）。
//    作者只做了静态审阅；**请 macOS 侧跑 `bash build.sh --probe` 后把结果回填**：
//      · 编译是否通过（swiftc 版本）
//      · --probe 输出的 state / lastSyncAt / tip 三行
//      · 菜单栏图标与角标是否与 Windows 版视觉一致
//    在此之前，本文件的正确性状态是"未验证"，不要当成可用件（conventions §3 假绿防线）。
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
}

/// 跑 `node sync-status.mjs --out <tmp>` 再按 UTF-8 读文件。
/// **不走管道**：这样完全不经过控制台编码（Windows 侧实测过同一类坑），macOS 上也更省心。
func loadBrief() -> Brief {
    var b = Brief()
    guard FileManager.default.fileExists(atPath: statusTool) else { b.error = "缺 \(statusTool)"; return b }
    let tmp = NSTemporaryDirectory() + "ai-sync-brief-\(ProcessInfo.processInfo.processIdentifier).json"
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")   // GUI 启动时 PATH 极小，必须经登录 shell 找 node
    p.arguments = ["-lc", "node '\(statusTool)' --instance '\(instanceRoot)' --out '\(tmp)' --no-fetch --quiet"]
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

final class AppDelegate: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var timer: Timer?
    var lastState = ""

    func applicationDidFinishLaunching(_ note: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        buildMenu()
        refresh(balloon: false)
        timer = Timer.scheduledTimer(withTimeInterval: 120, repeats: true) { _ in self.refresh(balloon: true) }
    }

    func buildMenu() {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "简报…", action: #selector(showBrief), keyEquivalent: "b"))
        menu.addItem(NSMenuItem(title: "立即同步", action: #selector(runTick), keyEquivalent: "s"))
        menu.addItem(NSMenuItem(title: "打开日志", action: #selector(openLog), keyEquivalent: "l"))
        menu.addItem(NSMenuItem(title: "随登录自启", action: #selector(toggleAutostart), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
    }

    @objc func refresh(balloon: Bool) {
        let b = loadBrief()
        let st = b.ok ? b.state : "fail"
        item.button?.image = makeIcon(state: st)
        item.button?.toolTip = tooltip(b)
        if balloon && st != "ok" && st != lastState {
            // 只在**状态跳变**时提示一次（否则每 2 分钟骚扰）
            let n = NSUserNotification()
            n.title = "ai-sync 同步"
            n.informativeText = tooltip(b)
            NSUserNotificationCenter.default.deliver(n)
        }
        lastState = st
    }

    @objc func showBrief() {
        let b = loadBrief()
        let alert = NSAlert()
        alert.messageText = b.ok ? "同步简报 · \(b.state.uppercased())" : "同步状态不可用"
        var lines: [String] = []
        if b.ok {
            let ago = b.agoMin.map { "\($0) 分钟前" } ?? "刚刚"
            lines.append("最后同步：\(b.lastSyncAt)（\(ago)）  间隔：\(b.interval) 分钟")
            lines.append("")
            lines.append(contentsOf: b.checkLines)
            if !b.machines.isEmpty {
                lines.append(""); lines.append("--- 全队 ---")
                for m in b.machines { lines.append("\(m.0)  \(m.1)  \(m.2.map { "\($0) 分钟前" } ?? "")  rc=\(m.3)  待办=\(m.4)") }
            }
            if !b.actions.isEmpty {
                lines.append(""); lines.append("--- 待办 ---")
                for a in b.actions { lines.append("· [\(a.0)] \(a.1)") }
            }
        } else { lines.append(b.error) }
        alert.informativeText = lines.joined(separator: "\n")
        alert.runModal()
    }

    @objc func runTick() {
        let tick = (engineRoot as NSString).appendingPathComponent("tools/sync-tick.mjs")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "node '\(tick)' --instance '\(instanceRoot)'"]
        try? p.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.refresh(balloon: false) }
    }

    @objc func openLog() {
        let f = (logDir as NSString).appendingPathComponent("tick-\(Self.dayStamp()).log")
        NSWorkspace.shared.open(FileManager.default.fileExists(atPath: f) ? URL(fileURLWithPath: f) : URL(fileURLWithPath: logDir))
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
        refresh(balloon: false)
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
    let b = loadBrief()
    print("state=\(b.ok ? b.state : "fail")  ok=\(b.ok)")
    print("lastSyncAt=\(b.lastSyncAt)  agoMin=\(b.agoMin.map(String.init) ?? "-")  interval=\(b.interval)")
    print("actions=\(b.actions.count)")
    print("tip:")
    for line in tooltip(b).split(separator: "\n") { print("  |\(line)") }
    for st in ["ok", "warn", "fail"] { _ = makeIcon(state: st) }
    print("icons: ok/warn/fail 已生成")
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)     // 无 Dock 图标
app.run()
