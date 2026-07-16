import Foundation

@MainActor
final class HeyCyanCommandController: ObservableObject {
    @Published private(set) var sdkAvailable = false
    @Published private(set) var message = "QCSDK not linked"

    init() {
        sdkAvailable = NSClassFromString("QCSDKCmdCreator") != nil
        message = sdkAvailable ? "QCSDK detected" : "QCSDK not linked"
    }

    func startRecording() async throws {
        try await sendSDKMode(mode: 1, actionName: "start video")
    }

    func stopRecording() async throws {
        try await sendSDKMode(mode: 2, actionName: "stop video")
    }

    func openTransferMode() async throws -> WiFiCredentials {
        // The public documentation shows QCSDKCmdCreator.openWifiWithMode returning SSID/password,
        // but this dynamic bridge intentionally avoids compile-time linkage to the proprietary SDK.
        // Once QCSDK.framework is added, replace this with a small Objective-C adapter that calls:
        // [QCSDKCmdCreator openWifiWithMode:QCOperatorDeviceModeTransfer success:... fail:...]
        throw AppError.missingSDK
    }

    private func sendSDKMode(mode: Int, actionName: String) async throws {
        guard sdkAvailable else {
            throw AppError.missingSDK
        }
        // Same note as above: command mode constants are documented, but invoking Objective-C
        // class methods with block parameters should be handled through a tiny Obj-C adapter.
        // This method is deliberately explicit instead of sending unknown raw packets.
        throw AppError.missingSDK
    }
}
