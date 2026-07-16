import Foundation

enum WorkoutStatus: String {
    case idle = "Ready"
    case scanning = "Scanning"
    case connected = "Connected"
    case recording = "Recording"
    case transfer = "Transfer"
    case uploading = "Uploading"
    case complete = "Complete"
    case failed = "Failed"
}

struct GlassesDevice: Identifiable, Equatable {
    let id: UUID
    let name: String
    let rssi: Int
}

struct GlassesMediaFile: Identifiable, Equatable, Codable {
    let id = UUID()
    let filename: String
    let type: String
    let size: Int?
    let modifiedAt: Date?

    enum CodingKeys: String, CodingKey {
        case filename
        case type
        case size
        case modifiedAt
    }
}

struct GlassesManifest: Codable {
    let files: [GlassesMediaFile]
}

struct WorkoutClip: Identifiable, Equatable {
    let id: String
    let sessionId: String
    let localURL: URL
    let originalFilename: String
    let createdAt: Date
    let durationSeconds: Double
    var uploadState: String = "local"
}

struct CaptureMetadata: Codable {
    let capture_id: String
    let session_id: String
    let workout_id: String
    let label: String
    let exercise: String
    let camera_angle: String
    let capture_type: String
    let drill_id: String
    let drill_title: String
    let duration_seconds: Double
    let recording_started_at: String
    let created_at: String
    let source: String
    let source_filename: String
    let training_intent: String
    let use_for_training: Bool
    let video_file: String
    let video_mime_type: String
    let azure_blob_prefix: String
    let video_blob: String
    let metadata_blob: String
}

enum AppError: LocalizedError {
    case missingSDK
    case noWritableCharacteristic
    case noManifest
    case noVideoFiles
    case badURL(String)
    case azureNotConfigured

    var errorDescription: String? {
        switch self {
        case .missingSDK:
            return "HeyCyan QCSDK is not installed. BLE probing works, but camera commands need the vendor SDK or reverse-engineered command bytes."
        case .noWritableCharacteristic:
            return "No writable BLE characteristic was found."
        case .noManifest:
            return "The glasses hotspot did not expose manifest.json."
        case .noVideoFiles:
            return "No video files were found in the glasses manifest."
        case .badURL(let value):
            return "Bad URL: \(value)"
        case .azureNotConfigured:
            return "Azure SAS URL is not configured."
        }
    }
}

func isoString(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

func safeSlug(_ value: String, fallback: String = "capture") -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
    let scalars = value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
    let slug = String(scalars).split(separator: "_").joined(separator: "_")
    return slug.isEmpty ? fallback : slug
}
