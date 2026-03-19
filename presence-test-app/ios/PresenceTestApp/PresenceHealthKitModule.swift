// PresenceHealthKitModule.swift
//
// React Native bridge for Apple HealthKit.
// Exposes heart rate and step count reading to JS.
//
// JS counterpart: presence-mobile/src/health/healthkit.ts
//
// Required Info.plist entries:
//   NSHealthShareUsageDescription
//
// Required Podfile:
//   pod 'RCTAppleHealthKit', :path => '../node_modules/react-native-health'
//   (or use this module directly without react-native-health)
//
// Note: This module reads data only. No HealthKit writes.

import Foundation
import HealthKit

@objc(PresenceHealthKit)
class PresenceHealthKitModule: NSObject {

  private static let observedTypeIdentifiers: [HKQuantityTypeIdentifier] = [.heartRate, .stepCount]
  private static var observersRegistered = false

  private let store = HKHealthStore()

  // MARK: - RN Module Name

  @objc static func moduleName() -> String { "PresenceHealthKit" }
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc static func registerObservers() {
    guard HKHealthStore.isHealthDataAvailable(), !Self.observersRegistered else { return }

    let store = HKHealthStore()
    for identifier in Self.observedTypeIdentifiers {
      guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { continue }

      let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completionHandler, error in
        if error == nil {
          PresenceBackgroundRefreshModule.recordExternalTrigger("healthkit")
        }
        completionHandler()
      }
      store.execute(query)

      store.enableBackgroundDelivery(for: type, frequency: .immediate) { _, _ in }
    }

    Self.observersRegistered = true
  }

  // MARK: - Availability

  /// Check if HealthKit is available on this device.
  /// iPads and some simulators do not support HealthKit.
  @objc func isAvailable(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(HKHealthStore.isHealthDataAvailable())
  }

  // MARK: - Permissions

  /// Request read permission for HeartRate and StepCount.
  /// On iOS, permission prompt is shown once; subsequent calls
  /// return immediately (silently granted or denied).
  @objc func requestPermissions(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard HKHealthStore.isHealthDataAvailable() else {
      reject("ERR_HEALTHKIT_UNAVAILABLE", "HealthKit is not available on this device", nil)
      return
    }

    guard
      let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate),
      let stepType = HKQuantityType.quantityType(forIdentifier: .stepCount)
    else {
      reject("ERR_HEALTHKIT_UNAVAILABLE", "Required HealthKit types unavailable", nil)
      return
    }

    let readTypes: Set<HKObjectType> = [heartRateType, stepType]

    store.requestAuthorization(toShare: nil, read: readTypes) { success, error in
      if let error = error {
        reject("ERR_HEALTHKIT_PERMISSION_DENIED", error.localizedDescription, error)
        return
      }
      // iOS does not tell us if the user denied — success is always true
      // unless there's a system error. Actual data access will fail silently.
      if success {
        Self.registerObservers()
      }
      resolve(success)
    }
  }

  // MARK: - Heart Rate

  /// Read recent heart rate samples from HealthKit.
  ///
  /// Parameters (JS options object):
  ///   startDate: ISO8601 string
  ///   endDate:   ISO8601 string
  ///   limit:     max number of samples (default 50)
  ///   ascending: bool (default false = most recent first)
  ///
  /// Returns array of { value: bpm, startDate: ISO, endDate: ISO }
  @objc func getHeartRateSamples(
    _ options: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard
      let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate)
    else {
      reject("ERR_NO_BPM_DATA", "HeartRate type unavailable", nil)
      return
    }

    let (startDate, endDate) = parseDateRange(options)
    let limit = options["limit"] as? Int ?? 50
    let ascending = options["ascending"] as? Bool ?? false

    let predicate = HKQuery.predicateForSamples(
      withStart: startDate,
      end: endDate,
      options: .strictStartDate
    )
    let sortDescriptor = NSSortDescriptor(
      key: HKSampleSortIdentifierEndDate,
      ascending: ascending
    )

    let query = HKSampleQuery(
      sampleType: heartRateType,
      predicate: predicate,
      limit: limit,
      sortDescriptors: [sortDescriptor]
    ) { _, samples, error in
      if let error = error {
        reject("ERR_NO_BPM_DATA", error.localizedDescription, error)
        return
      }

      guard let samples = samples as? [HKQuantitySample], !samples.isEmpty else {
        reject("ERR_NO_BPM_DATA", "No heart rate samples in window", nil)
        return
      }

      let beatsPerMinute = HKUnit.count().unitDivided(by: .minute())
      let result = samples.map { sample -> [String: Any] in
        [
          "value": sample.quantity.doubleValue(for: beatsPerMinute),
          "startDate": ISO8601DateFormatter().string(from: sample.startDate),
          "endDate": ISO8601DateFormatter().string(from: sample.endDate),
        ]
      }

      resolve(result)
    }

    store.execute(query)
  }

  // MARK: - Step Count

  /// Read cumulative step count over a time window.
  ///
  /// Parameters (JS options object):
  ///   startDate: ISO8601 string
  ///   endDate:   ISO8601 string
  ///
  /// Returns { value: steps, startDate: ISO, endDate: ISO }
  @objc func getStepCount(
    _ options: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard
      let stepType = HKQuantityType.quantityType(forIdentifier: .stepCount)
    else {
      reject("ERR_STEPS_UNAVAILABLE", "StepCount type unavailable", nil)
      return
    }

    let (startDate, endDate) = parseDateRange(options)

    let predicate = HKQuery.predicateForSamples(
      withStart: startDate,
      end: endDate,
      options: .strictStartDate
    )

    // Use statistics query for cumulative sum
    let query = HKStatisticsQuery(
      quantityType: stepType,
      quantitySamplePredicate: predicate,
      options: .cumulativeSum
    ) { _, statistics, error in
      if let error = error {
        reject("ERR_STEPS_UNAVAILABLE", error.localizedDescription, error)
        return
      }

      let steps = statistics?.sumQuantity()?.doubleValue(for: .count()) ?? 0

      resolve([
        "value": steps,
        "startDate": ISO8601DateFormatter().string(from: startDate ?? Date()),
        "endDate": ISO8601DateFormatter().string(from: endDate ?? Date()),
      ])
    }

    store.execute(query)
  }

  // MARK: - Helpers

  private func parseDateRange(_ options: NSDictionary) -> (Date?, Date?) {
    // React Native sends ISO8601 strings with fractional seconds (e.g. "2026-03-07T14:19:55.123Z").
    // The default ISO8601DateFormatter does NOT parse fractional seconds, causing date(from:) to
    // return nil — which makes HealthKit predicates ignore the date range entirely (returning all
    // historical data). We must explicitly enable .withFractionalSeconds.
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let start = (options["startDate"] as? String).flatMap { formatter.date(from: $0) }
    let end   = (options["endDate"]   as? String).flatMap { formatter.date(from: $0) }
    return (start, end)
  }
}
