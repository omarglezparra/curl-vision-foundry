import Foundation

struct CaptureMetadataFactory {
    static func makeMetadata(for clip: WorkoutClip) -> CaptureMetadata {
        let extensionValue = clip.localURL.pathExtension.isEmpty ? "mp4" : clip.localURL.pathExtension.lowercased()
        let videoFile = "video.\(extensionValue)"
        let prefix = "unlabeled/mirror_bv100/\(clip.sessionId)/\(clip.id)"

        return CaptureMetadata(
            capture_id: clip.id,
            session_id: clip.sessionId,
            workout_id: clip.sessionId,
            label: "unlabeled",
            exercise: "biceps_curl",
            camera_angle: "mirror_bv100",
            capture_type: "set",
            drill_id: "heycyan_bv100_native",
            drill_title: "HeyCyan BV100 native capture",
            duration_seconds: clip.durationSeconds,
            recording_started_at: isoString(clip.createdAt),
            created_at: isoString(),
            source: "heycyan_bv100_native_ios",
            source_filename: clip.originalFilename,
            training_intent: "unreviewed",
            use_for_training: false,
            video_file: videoFile,
            video_mime_type: mimeType(forExtension: extensionValue),
            azure_blob_prefix: prefix,
            video_blob: "\(prefix)/\(videoFile)",
            metadata_blob: "\(prefix)/metadata.json"
        )
    }

    static func mimeType(forExtension extensionValue: String) -> String {
        switch extensionValue.lowercased() {
        case "mov":
            return "video/quicktime"
        case "m4v":
            return "video/x-m4v"
        case "webm":
            return "video/webm"
        case "avi":
            return "video/x-msvideo"
        default:
            return "video/mp4"
        }
    }
}
