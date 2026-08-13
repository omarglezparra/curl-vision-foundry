import AVFoundation
import Foundation
import NetworkExtension

struct WiFiCredentials: Equatable {
    var ssid: String
    var password: String
}

@MainActor
final class WiFiTransferManager: ObservableObject {
    @Published var baseURLString = "http://192.168.4.1"
    @Published private(set) var transferLog: [String] = []
    @Published private(set) var liveStreamCandidate: URL?

    func joinHotspot(credentials: WiFiCredentials) async throws {
        let configuration = NEHotspotConfiguration(ssid: credentials.ssid, passphrase: credentials.password, isWEP: false)
        configuration.joinOnce = true
        try await NEHotspotConfigurationManager.shared.apply(configuration)
        appendLog("Joined hotspot \(credentials.ssid)")
    }

    func fetchManifest() async throws -> GlassesManifest {
        let baseURL = try baseURL()
        let manifestURL = baseURL.appendingPathComponent("manifest.json")
        appendLog("Fetching \(manifestURL.absoluteString)")
        let (data, response) = try await URLSession.shared.data(from: manifestURL)
        try ensureOK(response)
        let files = try parseManifest(data: data)
        appendLog("Manifest files: \(files.count)")
        return GlassesManifest(files: files)
    }

    func downloadNewestVideo(sessionId: String) async throws -> WorkoutClip {
        let manifest = try await fetchManifest()
        let videos = manifest.files.filter { file in
            let lower = file.filename.lowercased()
            return lower.hasSuffix(".mp4") || lower.hasSuffix(".mov") || lower.hasSuffix(".m4v")
        }
        guard let newest = videos.sorted(by: { ($0.modifiedAt ?? .distantPast) > ($1.modifiedAt ?? .distantPast) }).first else {
            throw AppError.noVideoFiles
        }

        let baseURL = try baseURL()
        let fileURL = baseURL.appendingPathComponent("files").appendingPathComponent(newest.filename)
        appendLog("Downloading \(fileURL.absoluteString)")
        let (tempURL, response) = try await URLSession.shared.download(from: fileURL)
        do {
            try ensureOK(response)
        } catch {
            try? FileManager.default.removeItem(at: tempURL)
            throw error
        }

        let destinationDirectory = try localCaptureDirectory()
        let destination = destinationDirectory.appendingPathComponent(newest.filename)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: tempURL, to: destination)

        let duration = await videoDuration(url: destination)
        appendLog("Downloaded \(newest.filename)")
        return WorkoutClip(
            id: "native_\(safeSlug(isoString().replacingOccurrences(of: ":", with: "_").replacingOccurrences(of: ".", with: "_")))",
            sessionId: sessionId,
            localURL: destination,
            originalFilename: newest.filename,
            createdAt: newest.modifiedAt ?? Date(),
            durationSeconds: duration
        )
    }

    func probeLiveStream() async {
        liveStreamCandidate = nil
        guard let baseURL = try? baseURL() else { return }
        let paths = ["stream", "live", "video", "mjpeg", "camera", "api/stream"]
        for path in paths {
            let candidate = baseURL.appendingPathComponent(path)
            do {
                var request = URLRequest(url: candidate)
                request.timeoutInterval = 2.0
                let (_, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    liveStreamCandidate = candidate
                    appendLog("Live stream candidate: \(candidate.absoluteString)")
                    return
                }
            } catch {
                appendLog("No stream at /\(path)")
            }
        }
        appendLog("No public live stream endpoint found")
    }

    func appendLog(_ message: String) {
        let line = "\(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium))  \(message)"
        transferLog.append(line)
        if transferLog.count > 120 {
            transferLog.removeFirst(transferLog.count - 120)
        }
    }

    private func baseURL() throws -> URL {
        guard let url = URL(string: baseURLString) else {
            throw AppError.badURL(baseURLString)
        }
        return url
    }

    private func ensureOK(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw AppError.badURL("HTTP \(http.statusCode)")
        }
    }

    private func parseManifest(data: Data) throws -> [GlassesMediaFile] {
        if let manifest = try? JSONDecoder.manifestDecoder.decode(GlassesManifest.self, from: data) {
            return manifest.files
        }
        if let files = try? JSONDecoder.manifestDecoder.decode([GlassesMediaFile].self, from: data) {
            return files
        }
        let json = try JSONSerialization.jsonObject(with: data)
        if let dictionary = json as? [String: Any], let rawFiles = dictionary["files"] as? [[String: Any]] {
            return rawFiles.compactMap(parseFileDictionary)
        }
        if let rawFiles = json as? [[String: Any]] {
            return rawFiles.compactMap(parseFileDictionary)
        }
        throw AppError.noManifest
    }

    private func parseFileDictionary(_ dictionary: [String: Any]) -> GlassesMediaFile? {
        let filename = (dictionary["filename"] ?? dictionary["name"] ?? dictionary["path"]) as? String
        guard let filename else { return nil }
        let type = (dictionary["type"] as? String) ?? "video"
        let size = dictionary["size"] as? Int
        let modifiedAt = parseDate(dictionary["modifiedAt"] ?? dictionary["mtime"] ?? dictionary["date"])
        return GlassesMediaFile(filename: filename, type: type, size: size, modifiedAt: modifiedAt)
    }

    private func parseDate(_ value: Any?) -> Date? {
        if let timestamp = value as? TimeInterval {
            return Date(timeIntervalSince1970: timestamp > 10_000_000_000 ? timestamp / 1000.0 : timestamp)
        }
        if let string = value as? String {
            return ISO8601DateFormatter().date(from: string)
        }
        return nil
    }

    private func localCaptureDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("HeyCyanCaptures", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func videoDuration(url: URL) async -> Double {
        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            return CMTimeGetSeconds(duration)
        } catch {
            return 0
        }
    }
}

private extension JSONDecoder {
    static var manifestDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

private extension NEHotspotConfigurationManager {
    func apply(_ configuration: NEHotspotConfiguration) async throws {
        try await withCheckedThrowingContinuation { continuation in
            apply(configuration) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }
}
