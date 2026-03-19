import BackgroundTasks
import Foundation

@objc(PresenceBackgroundRefresh)
class PresenceBackgroundRefreshModule: RCTEventEmitter {
  private static let taskIdentifier = "com.presence.testapp.refresh"
  private static let pendingTriggerDefaultsKey = "presence_bg_refresh_pending"
  private static let earliestRefreshDefaultsKey = "presence_bg_refresh_earliest"
  private static let lastTriggeredAtDefaultsKey = "presence_bg_refresh_last_triggered_at"
  private static let lastFinishedAtDefaultsKey = "presence_bg_refresh_last_finished_at"
  private static let lastFinishedSuccessDefaultsKey = "presence_bg_refresh_last_finished_success"
  private static let eventName = "PresenceBackgroundRefreshTriggered"

  private static var hasRegistered = false
  private static weak var sharedInstance: PresenceBackgroundRefreshModule?
  private static var currentTask: BGAppRefreshTask?

  private var hasListeners = false

  @objc override static func moduleName() -> String! { "PresenceBackgroundRefresh" }
  @objc override static func requiresMainQueueSetup() -> Bool { true }

  override init() {
    super.init()
    Self.sharedInstance = self
  }

  override func supportedEvents() -> [String]! {
    [Self.eventName]
  }

  override func startObserving() {
    self.hasListeners = true
    Self.sharedInstance = self
    self.flushPendingTriggerIfNeeded()
  }

  override func stopObserving() {
    self.hasListeners = false
  }

  @objc static func registerBackgroundTasks() {
    guard #available(iOS 13.0, *), !Self.hasRegistered else { return }

    Self.hasRegistered = BGTaskScheduler.shared.register(
      forTaskWithIdentifier: Self.taskIdentifier,
      using: nil
    ) { task in
      guard let refreshTask = task as? BGAppRefreshTask else {
        task.setTaskCompleted(success: false)
        return
      }
      Self.handle(refreshTask)
    }
    Self.hasRegistered = true
  }

  @objc static func schedulePersistedRefreshIfNeeded() {
    guard #available(iOS 13.0, *) else { return }
    let storedEpoch = UserDefaults.standard.double(forKey: Self.earliestRefreshDefaultsKey)
    guard storedEpoch > 0 else { return }
    try? Self.scheduleTask(earliestEpochSeconds: storedEpoch)
  }

  @objc func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    if #available(iOS 13.0, *) {
      resolve(true)
    } else {
      resolve(false)
    }
  }

  @objc func scheduleRefresh(
    _ earliestEpochSeconds: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 13.0, *) else {
      resolve(false)
      return
    }

    let epoch = earliestEpochSeconds.doubleValue
    UserDefaults.standard.set(epoch, forKey: Self.earliestRefreshDefaultsKey)

    do {
      try Self.scheduleTask(earliestEpochSeconds: epoch)
      resolve(true)
    } catch {
      reject("ERR_BACKGROUND_REFRESH", "Could not schedule background refresh: \(error.localizedDescription)", error)
    }
  }

  @objc func finish(
    _ success: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    let now = Date().timeIntervalSince1970
    UserDefaults.standard.set(now, forKey: Self.lastFinishedAtDefaultsKey)
    UserDefaults.standard.set(success.boolValue, forKey: Self.lastFinishedSuccessDefaultsKey)
    if #available(iOS 13.0, *) {
      Self.currentTask?.setTaskCompleted(success: success.boolValue)
      Self.currentTask = nil
    }
    resolve(true)
  }

  @objc func consumePendingTrigger(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    let pending = UserDefaults.standard.bool(forKey: Self.pendingTriggerDefaultsKey)
    if pending {
      UserDefaults.standard.removeObject(forKey: Self.pendingTriggerDefaultsKey)
    }
    resolve(pending)
  }

  @objc func getDiagnostics(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    let defaults = UserDefaults.standard
    var diagnostics: [String: Any] = [
      "supported": {
        if #available(iOS 13.0, *) { return true }
        return false
      }(),
      "pendingTrigger": defaults.bool(forKey: Self.pendingTriggerDefaultsKey),
      "scheduledEarliestEpochSeconds": defaults.double(forKey: Self.earliestRefreshDefaultsKey),
      "lastTriggeredAt": defaults.double(forKey: Self.lastTriggeredAtDefaultsKey),
      "lastFinishedAt": defaults.double(forKey: Self.lastFinishedAtDefaultsKey)
    ]
    if defaults.object(forKey: Self.lastFinishedSuccessDefaultsKey) != nil {
      diagnostics["lastFinishedSuccess"] = defaults.bool(forKey: Self.lastFinishedSuccessDefaultsKey)
    }
    resolve(diagnostics)
  }

  @available(iOS 13.0, *)
  private static func handle(_ task: BGAppRefreshTask) {
    Self.currentTask = task
    UserDefaults.standard.set(true, forKey: Self.pendingTriggerDefaultsKey)
    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.lastTriggeredAtDefaultsKey)

    task.expirationHandler = {
      UserDefaults.standard.removeObject(forKey: Self.pendingTriggerDefaultsKey)
      UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.lastFinishedAtDefaultsKey)
      UserDefaults.standard.set(false, forKey: Self.lastFinishedSuccessDefaultsKey)
      Self.currentTask?.setTaskCompleted(success: false)
      Self.currentTask = nil
    }

    DispatchQueue.main.async {
      Self.sharedInstance?.flushPendingTriggerIfNeeded()
    }
  }

  @objc static func recordExternalTrigger(_ source: NSString) {
    let now = Date().timeIntervalSince1970
    UserDefaults.standard.set(true, forKey: Self.pendingTriggerDefaultsKey)
    UserDefaults.standard.set(now, forKey: Self.lastTriggeredAtDefaultsKey)

    DispatchQueue.main.async {
      guard let instance = Self.sharedInstance, instance.hasListeners else { return }
      UserDefaults.standard.removeObject(forKey: Self.pendingTriggerDefaultsKey)
      instance.sendEvent(withName: Self.eventName, body: [
        "source": source,
        "triggeredAt": now,
      ])
    }
  }

  @available(iOS 13.0, *)
  private static func scheduleTask(earliestEpochSeconds: Double) throws {
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskIdentifier)
    let request = BGAppRefreshTaskRequest(identifier: Self.taskIdentifier)
    request.earliestBeginDate = Date(timeIntervalSince1970: max(earliestEpochSeconds, Date().timeIntervalSince1970 + 1))
    try BGTaskScheduler.shared.submit(request)
  }

  private func flushPendingTriggerIfNeeded() {
    guard self.hasListeners else { return }
    guard UserDefaults.standard.bool(forKey: Self.pendingTriggerDefaultsKey) else { return }

    UserDefaults.standard.removeObject(forKey: Self.pendingTriggerDefaultsKey)
    self.sendEvent(withName: Self.eventName, body: [
      "source": "bg_task",
      "triggeredAt": UserDefaults.standard.double(forKey: Self.lastTriggeredAtDefaultsKey)
    ])
  }
}
