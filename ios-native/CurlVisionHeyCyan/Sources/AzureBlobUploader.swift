import Foundation

@MainActor
final class AzureBlobUploader: ObservableObject {
    @Published var containerSASURL = ""
    @Published private(set) var uploadLog: [String] = []

    func upload(clip: WorkoutClip) async throws {
        guard !containerSASURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AppError.azureNotConfigured
        }

        let metadata = CaptureMetadataFactory.makeMetadata(for: clip)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let metadataData = try encoder.encode(metadata)
        let localURL = clip.localURL
        let videoData = try await Task.detached(priority: .userInitiated) {
            try Data(contentsOf: localURL)
        }.value

        appendLog("Uploading video \(metadata.video_blob)")
        try await putBlob(name: metadata.video_blob, data: videoData, contentType: metadata.video_mime_type)
        appendLog("Uploading metadata \(metadata.metadata_blob)")
        try await putBlob(name: metadata.metadata_blob, data: metadataData, contentType: "application/json")
        appendLog("Upload complete")
    }

    func blobURL(for blobName: String) throws -> URL {
        let clean = containerSASURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let question = clean.firstIndex(of: "?") else {
            throw AppError.badURL(clean)
        }
        let base = String(clean[..<question]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let query = clean[question...]
        let encodedPath = blobName.split(separator: "/").map { component in
            String(component).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(component)
        }.joined(separator: "/")
        guard let url = URL(string: "\(base)/\(encodedPath)\(query)") else {
            throw AppError.badURL(clean)
        }
        return url
    }

    private func putBlob(name: String, data: Data, contentType: String) async throws {
        var request = URLRequest(url: try blobURL(for: name))
        request.httpMethod = "PUT"
        request.setValue("BlockBlob", forHTTPHeaderField: "x-ms-blob-type")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (_, response) = try await URLSession.shared.upload(for: request, from: data)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw AppError.badURL("\(name) upload HTTP \(http.statusCode)")
        }
    }

    private func appendLog(_ message: String) {
        let line = "\(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium))  \(message)"
        uploadLog.append(line)
        if uploadLog.count > 120 {
            uploadLog.removeFirst(uploadLog.count - 120)
        }
    }
}
