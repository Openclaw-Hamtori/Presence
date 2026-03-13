import Foundation
import AVFoundation
import UIKit

@objc(PresenceQRScanner)
class PresenceQRScannerModule: NSObject {
  private var resolve: RCTPromiseResolveBlock?
  private var reject: RCTPromiseRejectBlock?
  private weak var scannerViewController: PresenceQRScannerViewController?
  private var hasResolved = false

  @objc static func moduleName() -> String { "PresenceQRScanner" }
  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    let supported = UIImagePickerController.isSourceTypeAvailable(.camera)
      && AVCaptureDevice.default(for: .video) != nil
    resolve(supported)
  }

  @objc func scanQRCode(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      if self.resolve != nil || self.reject != nil {
        reject("ERR_QR_BUSY", "A QR scan is already in progress", nil)
        return
      }

      self.resolve = resolve
      self.reject = reject
      self.hasResolved = false
      self.presentScanner()
    }
  }

  private func presentScanner() {
    guard UIImagePickerController.isSourceTypeAvailable(.camera), AVCaptureDevice.default(for: .video) != nil else {
      self.rejectOnce(code: "ERR_QR_UNAVAILABLE", message: "This device does not have a usable camera for QR scanning", error: nil)
      return
    }

    let authStatus = AVCaptureDevice.authorizationStatus(for: .video)
    switch authStatus {
    case .authorized:
      self.showScanner()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          if granted {
            self.showScanner()
          } else {
            self.rejectOnce(code: "ERR_CAMERA_PERMISSION_DENIED", message: "Camera permission is required to scan QR codes", error: nil)
          }
        }
      }
    default:
      self.rejectOnce(code: "ERR_CAMERA_PERMISSION_DENIED", message: "Camera permission is required to scan QR codes", error: nil)
    }
  }

  private func showScanner() {
    guard let presenter = Self.topViewController() else {
      self.rejectOnce(code: "ERR_QR_UNAVAILABLE", message: "Could not find a screen to present the QR scanner", error: nil)
      return
    }

    let scanner = PresenceQRScannerViewController()
    scanner.onCodeScanned = { [weak self] payload in
      self?.resolveOnce(payload)
    }
    scanner.onCancel = { [weak self] in
      self?.rejectOnce(code: "ERR_QR_CANCELLED", message: "QR scan cancelled", error: nil)
    }
    scanner.onFailure = { [weak self] message in
      self?.rejectOnce(code: "ERR_QR_UNAVAILABLE", message: message, error: nil)
    }

    self.scannerViewController = scanner
    presenter.present(scanner, animated: true)
  }

  private func resolveOnce(_ payload: String) {
    guard !self.hasResolved else { return }
    self.hasResolved = true
    let resolver = self.resolve
    self.cleanupScanner {
      resolver?(payload)
    }
  }

  private func rejectOnce(code: String, message: String, error: Error?) {
    guard !self.hasResolved else { return }
    self.hasResolved = true
    let rejecter = self.reject
    self.cleanupScanner {
      rejecter?(code, message, error)
    }
  }

  private func cleanupScanner(completion: @escaping () -> Void) {
    DispatchQueue.main.async {
      if let scanner = self.scannerViewController {
        scanner.stopScanning()
        scanner.dismiss(animated: true) {
          self.scannerViewController = nil
          self.resolve = nil
          self.reject = nil
          completion()
        }
      } else {
        self.scannerViewController = nil
        self.resolve = nil
        self.reject = nil
        completion()
      }
    }
  }

  private static func topViewController(base: UIViewController? = {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let keyWindow = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
    return keyWindow?.rootViewController
  }()) -> UIViewController? {
    if let nav = base as? UINavigationController {
      return topViewController(base: nav.visibleViewController)
    }
    if let tab = base as? UITabBarController, let selected = tab.selectedViewController {
      return topViewController(base: selected)
    }
    if let presented = base?.presentedViewController {
      return topViewController(base: presented)
    }
    return base
  }
}

private final class PresenceQRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var onCodeScanned: ((String) -> Void)?
  var onCancel: (() -> Void)?
  var onFailure: ((String) -> Void)?

  private let session = AVCaptureSession()
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var didFinish = false
  private let sessionQueue = DispatchQueue(label: "PresenceQRScanner.capture")

  private let titleLabel: UILabel = {
    let label = UILabel()
    label.translatesAutoresizingMaskIntoConstraints = false
    label.text = "Scan Presence QR"
    label.textColor = .white
    label.font = .systemFont(ofSize: 24, weight: .semibold)
    return label
  }()

  private let hintLabel: UILabel = {
    let label = UILabel()
    label.translatesAutoresizingMaskIntoConstraints = false
    label.text = "Align the QR code inside the frame"
    label.textColor = UIColor.white.withAlphaComponent(0.82)
    label.font = .systemFont(ofSize: 15, weight: .medium)
    return label
  }()

  private let frameView: UIView = {
    let view = UIView()
    view.translatesAutoresizingMaskIntoConstraints = false
    view.layer.cornerRadius = 24
    view.layer.borderWidth = 2
    view.layer.borderColor = UIColor.white.withAlphaComponent(0.95).cgColor
    view.backgroundColor = .clear
    return view
  }()

  private lazy var closeButton: UIButton = {
    let button = UIButton(type: .system)
    button.translatesAutoresizingMaskIntoConstraints = false
    button.setTitle("Close", for: .normal)
    button.setTitleColor(.white, for: .normal)
    button.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
    button.backgroundColor = UIColor.black.withAlphaComponent(0.42)
    button.layer.cornerRadius = 14
    button.contentEdgeInsets = UIEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
    button.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
    return button
  }()

  override func viewDidLoad() {
    super.viewDidLoad()
    self.view.backgroundColor = .black
    self.modalPresentationStyle = .fullScreen
    self.setupPreviewLayer()
    self.setupOverlay()
    self.configureCaptureSession()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    self.previewLayer?.frame = self.view.bounds
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    self.startScanning()
  }

  func stopScanning() {
    self.sessionQueue.async {
      if self.session.isRunning {
        self.session.stopRunning()
      }
    }
  }

  private func setupPreviewLayer() {
    let previewLayer = AVCaptureVideoPreviewLayer(session: self.session)
    previewLayer.videoGravity = .resizeAspectFill
    previewLayer.frame = self.view.bounds
    self.view.layer.addSublayer(previewLayer)
    self.previewLayer = previewLayer
  }

  private func setupOverlay() {
    let overlay = UIView()
    overlay.translatesAutoresizingMaskIntoConstraints = false
    overlay.backgroundColor = .clear
    self.view.addSubview(overlay)

    overlay.addSubview(self.titleLabel)
    overlay.addSubview(self.hintLabel)
    overlay.addSubview(self.frameView)
    overlay.addSubview(self.closeButton)

    NSLayoutConstraint.activate([
      overlay.topAnchor.constraint(equalTo: self.view.topAnchor),
      overlay.leadingAnchor.constraint(equalTo: self.view.leadingAnchor),
      overlay.trailingAnchor.constraint(equalTo: self.view.trailingAnchor),
      overlay.bottomAnchor.constraint(equalTo: self.view.bottomAnchor),

      self.closeButton.topAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.topAnchor, constant: 16),
      self.closeButton.trailingAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.trailingAnchor, constant: -16),

      self.titleLabel.topAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.topAnchor, constant: 28),
      self.titleLabel.leadingAnchor.constraint(equalTo: self.view.leadingAnchor, constant: 24),
      self.titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: self.closeButton.leadingAnchor, constant: -12),

      self.hintLabel.topAnchor.constraint(equalTo: self.titleLabel.bottomAnchor, constant: 8),
      self.hintLabel.leadingAnchor.constraint(equalTo: self.titleLabel.leadingAnchor),
      self.hintLabel.trailingAnchor.constraint(equalTo: self.view.trailingAnchor, constant: -24),

      self.frameView.centerXAnchor.constraint(equalTo: self.view.centerXAnchor),
      self.frameView.centerYAnchor.constraint(equalTo: self.view.centerYAnchor, constant: -20),
      self.frameView.widthAnchor.constraint(equalTo: self.view.widthAnchor, multiplier: 0.68),
      self.frameView.heightAnchor.constraint(equalTo: self.frameView.widthAnchor)
    ])
  }

  private func configureCaptureSession() {
    self.sessionQueue.async {
      self.session.beginConfiguration()
      self.session.sessionPreset = .high

      guard let device = AVCaptureDevice.default(for: .video) else {
        self.fail(message: "No camera is available for QR scanning")
        self.session.commitConfiguration()
        return
      }

      do {
        let input = try AVCaptureDeviceInput(device: device)
        if self.session.canAddInput(input) {
          self.session.addInput(input)
        } else {
          self.fail(message: "Could not attach the camera input")
          self.session.commitConfiguration()
          return
        }
      } catch {
        self.fail(message: "Could not open the camera for QR scanning")
        self.session.commitConfiguration()
        return
      }

      let output = AVCaptureMetadataOutput()
      if self.session.canAddOutput(output) {
        self.session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        if output.availableMetadataObjectTypes.contains(.qr) {
          output.metadataObjectTypes = [.qr]
        } else {
          self.fail(message: "QR scanning is not supported by this camera")
          self.session.commitConfiguration()
          return
        }
      } else {
        self.fail(message: "Could not configure the QR scanner")
        self.session.commitConfiguration()
        return
      }

      self.session.commitConfiguration()
    }
  }

  private func startScanning() {
    self.sessionQueue.async {
      guard !self.session.isRunning, !self.didFinish else { return }
      self.session.startRunning()
    }
  }

  @objc private func closeTapped() {
    self.finishOnce {
      self.onCancel?()
    }
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !self.didFinish else { return }
    guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
          object.type == .qr,
          let payload = object.stringValue,
          !payload.isEmpty else {
      return
    }

    self.finishOnce {
      self.onCodeScanned?(payload)
    }
  }

  private func fail(message: String) {
    DispatchQueue.main.async {
      self.finishOnce {
        self.onFailure?(message)
      }
    }
  }

  private func finishOnce(_ action: @escaping () -> Void) {
    guard !self.didFinish else { return }
    self.didFinish = true
    self.stopScanning()
    action()
  }
}
