import Foundation

@MainActor
final class WorkoutViewModel: ObservableObject {
    @Published var status: WorkoutStatus = .idle
    @Published var sessionId = "heycyan_\(safeSlug(isoString()))"
    @Published var lastClip: WorkoutClip?
    @Published var errorMessage = ""

    let ble = GlassesBLEManager()
    let commands = HeyCyanCommandController()
    let transfer = WiFiTransferManager()
    let uploader = AzureBlobUploader()

    func scan() {
        errorMessage = ""
        status = .scanning
        ble.scan()
    }

    func connect(to device: GlassesDevice) {
        errorMessage = ""
        ble.connect(to: device)
        status = .connected
    }

    func newSession() {
        sessionId = "heycyan_\(safeSlug(isoString()))"
        lastClip = nil
        errorMessage = ""
        status = .idle
    }

    func startWorkoutRecording() async {
        await run(status: .recording) {
            try await commands.startRecording()
        }
    }

    func stopWorkoutRecording() async {
        await run(status: .connected) {
            try await commands.stopRecording()
        }
    }

    func openTransferMode() async {
        await run(status: .transfer) {
            _ = try await commands.openTransferMode()
        }
    }

    func downloadNewestVideo() async {
        await run(status: .transfer) {
            let clip = try await transfer.downloadNewestVideo(sessionId: sessionId)
            lastClip = clip
            status = .complete
        }
    }

    func uploadLastClip() async {
        guard let clip = lastClip else {
            errorMessage = "No downloaded clip yet"
            return
        }
        await run(status: .uploading) {
            try await uploader.upload(clip: clip)
            lastClip?.uploadState = "uploaded"
            status = .complete
        }
    }

    func probeLiveStream() async {
        status = .transfer
        await transfer.probeLiveStream()
        status = .complete
    }

    private func run(status nextStatus: WorkoutStatus, operation: () async throws -> Void) async {
        errorMessage = ""
        status = nextStatus
        do {
            try await operation()
        } catch {
            errorMessage = error.localizedDescription
            status = .failed
        }
    }
}
