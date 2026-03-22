import Foundation
import UIKit
import UserNotifications

private final class PresencePushNotificationsCoordinator: NSObject, UNUserNotificationCenterDelegate {
  static let shared = PresencePushNotificationsCoordinator()

  static let tokenRegisteredEvent = "PresencePushTokenRegistered"
  static let registrationFailedEvent = "PresencePushRegistrationFailed"
  static let notificationReceivedEvent = "PresencePushNotificationReceived"
  static let notificationResponseEvent = "PresencePushNotificationResponse"

  private weak var emitter: PresencePushNotificationsModule?
  private var hasListeners = false
  private var pendingEvents: [(name: String, body: [String: Any])] = []
  private var initialNotificationResponse: [String: Any]?

  func attach(emitter: PresencePushNotificationsModule) {
    self.emitter = emitter
    self.flushPendingEventsIfPossible()
  }

  func setHasListeners(_ hasListeners: Bool) {
    self.hasListeners = hasListeners
    self.flushPendingEventsIfPossible()
  }

  func getAuthorizationStatus(
    _ resolve: @escaping RCTPromiseResolveBlock
  ) {
    if #available(iOS 10.0, *) {
      UNUserNotificationCenter.current().getNotificationSettings { settings in
        resolve(Self.authorizationStatusString(settings.authorizationStatus))
      }
      return
    }
    resolve("unsupported")
  }

  func registerForPushNotifications(
    prompt: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 10.0, *) else {
      resolve([
        "status": "unsupported",
        "registrationRequested": false,
      ])
      return
    }

    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      let currentStatus = Self.authorizationStatusString(settings.authorizationStatus)

      if settings.authorizationStatus == .notDetermined && prompt {
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
          if let error = error {
            reject("ERR_PUSH_REGISTRATION_FAILED", error.localizedDescription, error)
            return
          }

          center.getNotificationSettings { refreshedSettings in
            let refreshedStatus = Self.authorizationStatusString(refreshedSettings.authorizationStatus)
            if granted || Self.isAuthorizedStatus(refreshedSettings.authorizationStatus) {
              DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
              }
              resolve([
                "status": refreshedStatus,
                "registrationRequested": true,
              ])
            } else {
              resolve([
                "status": refreshedStatus,
                "registrationRequested": false,
              ])
            }
          }
        }
        return
      }

      if Self.isAuthorizedStatus(settings.authorizationStatus) {
        DispatchQueue.main.async {
          UIApplication.shared.registerForRemoteNotifications()
        }
        resolve([
          "status": currentStatus,
          "registrationRequested": true,
        ])
        return
      }

      resolve([
        "status": currentStatus,
        "registrationRequested": false,
      ])
    }
  }

  func consumeInitialNotificationResponse() -> [String: Any]? {
    let response = self.initialNotificationResponse
    self.initialNotificationResponse = nil
    return response
  }

  func didRegisterForRemoteNotifications(deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    guard token.count >= 64, token.count % 2 == 0 else {
      self.enqueueOrEmit(
        name: Self.registrationFailedEvent,
        body: [
          "message": "invalid apns token format received",
        ]
      )
      return
    }

    self.enqueueOrEmit(
      name: Self.tokenRegisteredEvent,
      body: [
        "token": token,
        "environment": Self.currentEnvironment(),
        "bundleId": Bundle.main.bundleIdentifier ?? NSNull(),
      ]
    )
  }

  func didFailToRegisterForRemoteNotifications(error: Error) {
    self.enqueueOrEmit(
      name: Self.registrationFailedEvent,
      body: [
        "message": error.localizedDescription,
      ]
    )
  }

  func handleRemoteNotification(userInfo: [AnyHashable: Any], source: String) {
    self.enqueueOrEmit(
      name: Self.notificationReceivedEvent,
      body: [
        "source": source,
        "payload": Self.normalizeDictionary(userInfo),
      ]
    )
  }

  @available(iOS 10.0, *)
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    self.enqueueOrEmit(
      name: Self.notificationReceivedEvent,
      body: [
        "source": "notification_foreground",
        "payload": Self.normalizeDictionary(notification.request.content.userInfo),
      ]
    )

    if #available(iOS 14.0, *) {
      completionHandler([.banner, .badge, .sound])
    } else {
      completionHandler([.alert, .badge, .sound])
    }
  }

  @available(iOS 10.0, *)
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let payload: [String: Any] = [
      "source": "notification_response",
      "payload": Self.normalizeDictionary(response.notification.request.content.userInfo),
      "actionIdentifier": response.actionIdentifier,
    ]
    self.initialNotificationResponse = payload
    self.enqueueOrEmit(name: Self.notificationResponseEvent, body: payload)
    completionHandler()
  }

  private func enqueueOrEmit(name: String, body: [String: Any]) {
    DispatchQueue.main.async {
      guard let emitter = self.emitter, self.hasListeners else {
        self.pendingEvents.append((name: name, body: body))
        return
      }
      emitter.sendEvent(withName: name, body: body)
    }
  }

  private func flushPendingEventsIfPossible() {
    guard let emitter = self.emitter, self.hasListeners, !self.pendingEvents.isEmpty else { return }

    let events = self.pendingEvents
    self.pendingEvents.removeAll()
    for event in events {
      emitter.sendEvent(withName: event.name, body: event.body)
    }
  }

  private static func authorizationStatusString(_ status: UNAuthorizationStatus) -> String {
    if #available(iOS 14.0, *), status == .ephemeral {
      return "ephemeral"
    }
    if #available(iOS 12.0, *), status == .provisional {
      return "provisional"
    }

    switch status {
    case .notDetermined:
      return "not_determined"
    case .denied:
      return "denied"
    case .authorized:
      return "authorized"
    @unknown default:
      return "unsupported"
    }
  }

  private static func isAuthorizedStatus(_ status: UNAuthorizationStatus) -> Bool {
    if status == .authorized {
      return true
    }
    if #available(iOS 12.0, *), status == .provisional {
      return true
    }
    if #available(iOS 14.0, *), status == .ephemeral {
      return true
    }
    return false
  }

  private static func currentEnvironment() -> String {
    #if DEBUG
      return "development"
    #else
      return "production"
    #endif
  }

  private static func normalizeDictionary(_ dictionary: [AnyHashable: Any]) -> [String: Any] {
    var normalized: [String: Any] = [:]
    for (key, value) in dictionary {
      normalized[String(describing: key)] = Self.normalizeValue(value)
    }
    return normalized
  }

  private static func normalizeValue(_ value: Any) -> Any {
    if let dictionary = value as? [AnyHashable: Any] {
      return normalizeDictionary(dictionary)
    }
    if let array = value as? [Any] {
      return array.map { normalizeValue($0) }
    }
    if value is NSNull || value is NSString || value is NSNumber {
      return value
    }
    if let string = value as? String {
      return string
    }
    return String(describing: value)
  }
}

@objc(PresencePushNotifications)
class PresencePushNotificationsModule: RCTEventEmitter {
  @objc override static func moduleName() -> String! { "PresencePushNotifications" }
  @objc override static func requiresMainQueueSetup() -> Bool { true }

  override init() {
    super.init()
    PresencePushNotificationsCoordinator.shared.attach(emitter: self)
  }

  override func supportedEvents() -> [String]! {
    [
      PresencePushNotificationsCoordinator.tokenRegisteredEvent,
      PresencePushNotificationsCoordinator.registrationFailedEvent,
      PresencePushNotificationsCoordinator.notificationReceivedEvent,
      PresencePushNotificationsCoordinator.notificationResponseEvent,
    ]
  }

  override func startObserving() {
    PresencePushNotificationsCoordinator.shared.attach(emitter: self)
    PresencePushNotificationsCoordinator.shared.setHasListeners(true)
  }

  override func stopObserving() {
    PresencePushNotificationsCoordinator.shared.setHasListeners(false)
  }

  @objc func getAuthorizationStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    PresencePushNotificationsCoordinator.shared.getAuthorizationStatus(resolve)
  }

  @objc func registerForPushNotifications(
    _ prompt: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    PresencePushNotificationsCoordinator.shared.registerForPushNotifications(
      prompt: prompt.boolValue,
      resolve: resolve,
      reject: reject
    )
  }

  @objc func consumeInitialNotificationResponse(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    resolve(PresencePushNotificationsCoordinator.shared.consumeInitialNotificationResponse())
  }

  @objc static func configure() {
    if #available(iOS 10.0, *) {
      DispatchQueue.main.async {
        UNUserNotificationCenter.current().delegate = PresencePushNotificationsCoordinator.shared
      }
    }
  }

  @objc static func didRegisterForRemoteNotifications(_ deviceToken: NSData) {
    PresencePushNotificationsCoordinator.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken as Data)
  }

  @objc static func didFailToRegisterForRemoteNotifications(_ error: NSError) {
    PresencePushNotificationsCoordinator.shared.didFailToRegisterForRemoteNotifications(error: error)
  }

  @objc static func handleRemoteNotification(_ userInfo: NSDictionary, source: NSString) {
    let payload = (userInfo as? [AnyHashable: Any]) ?? [:]
    PresencePushNotificationsCoordinator.shared.handleRemoteNotification(
      userInfo: payload,
      source: source as String
    )
  }
}
