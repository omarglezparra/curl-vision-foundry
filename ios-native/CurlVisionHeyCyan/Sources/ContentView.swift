import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: WorkoutViewModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    statusHeader
                    deviceSection
                    workoutSection
                    transferSection
                    azureSection
                    diagnosticsSection
                }
                .padding()
            }
            .background(Color(red: 0.95, green: 0.97, blue: 0.98))
            .navigationTitle("HeyCyan BV100")
        }
    }

    private var statusHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Curl Vision Foundry")
                .font(.caption.weight(.bold))
                .foregroundStyle(.blue)
                .textCase(.uppercase)
            Text("Native glasses capture")
                .font(.title.bold())
            HStack {
                Label(model.status.rawValue, systemImage: statusIcon)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button("Nueva sesion") {
                    model.newSession()
                }
                .buttonStyle(.bordered)
            }
            Text("session_id: \(model.sessionId)")
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            if !model.errorMessage.isEmpty {
                Text(model.errorMessage)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.red)
            }
        }
        .panelStyle()
    }

    private var deviceSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("1. Connect")
                .sectionTitle()
            HStack {
                Button("Escanear BLE") {
                    model.scan()
                }
                .buttonStyle(.borderedProminent)
                Button("Detener") {
                    model.ble.stopScan()
                }
                .buttonStyle(.bordered)
            }
            if model.ble.devices.isEmpty {
                Text("Busca el nombre HeyCyan, BV100, o un dispositivo cercano con buena senal.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.ble.devices) { device in
                    Button {
                        model.connect(to: device)
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(device.name)
                                    .font(.body.weight(.semibold))
                                Text(device.id.uuidString)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(device.rssi)")
                                .font(.caption.weight(.bold))
                        }
                    }
                    .buttonStyle(.bordered)
                }
            }
            if !model.ble.connectedName.isEmpty {
                Label("Conectado: \(model.ble.connectedName)", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
        }
        .panelStyle()
    }

    private var workoutSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("2. Record")
                .sectionTitle()
            Text("Los comandos start/stop requieren el SDK propietario de HeyCyan o los bytes BLE ya decodificados. Esta app ya deja la interfaz y el diagnostico listos.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Button("Start lentes") {
                    Task { await model.startWorkoutRecording() }
                }
                .buttonStyle(.borderedProminent)
                Button("Stop lentes") {
                    Task { await model.stopWorkoutRecording() }
                }
                .buttonStyle(.bordered)
            }
            Text("SDK: \(model.commands.message)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(model.commands.sdkAvailable ? .green : .orange)
        }
        .panelStyle()
    }

    private var transferSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("3. Transfer")
                .sectionTitle()
            TextField("Glasses base URL", text: $model.transfer.baseURLString)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Probe stream") {
                    Task { await model.probeLiveStream() }
                }
                .buttonStyle(.bordered)
                Button("Download newest") {
                    Task { await model.downloadNewestVideo() }
                }
                .buttonStyle(.borderedProminent)
            }
            if let candidate = model.transfer.liveStreamCandidate {
                Text("Live candidate: \(candidate.absoluteString)")
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
            }
            if let clip = model.lastClip {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Ultimo clip")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                    Text(clip.originalFilename)
                        .font(.body.weight(.semibold))
                    Text(clip.localURL.path)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
        .panelStyle()
    }

    private var azureSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("4. Upload")
                .sectionTitle()
            TextField("Azure container SAS URL", text: $model.uploader.containerSASURL, axis: .vertical)
                .textInputAutocapitalization(.never)
                .textFieldStyle(.roundedBorder)
                .lineLimit(3...6)
            Button("Subir ultimo clip") {
                Task { await model.uploadLastClip() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.lastClip == nil)
        }
        .panelStyle()
    }

    private var diagnosticsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Diagnostics")
                .sectionTitle()
            DisclosureGroup("BLE log") {
                logView(model.ble.diagnosticLog)
            }
            DisclosureGroup("Transfer log") {
                logView(model.transfer.transferLog)
            }
            DisclosureGroup("Azure log") {
                logView(model.uploader.uploadLog)
            }
        }
        .panelStyle()
    }

    private var statusIcon: String {
        switch model.status {
        case .idle:
            return "circle"
        case .scanning:
            return "antenna.radiowaves.left.and.right"
        case .connected:
            return "link"
        case .recording:
            return "record.circle"
        case .transfer:
            return "wifi"
        case .uploading:
            return "icloud.and.arrow.up"
        case .complete:
            return "checkmark.circle"
        case .failed:
            return "exclamationmark.triangle"
        }
    }

    private func logView(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if lines.isEmpty {
                Text("No entries yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.top, 6)
    }
}

private extension View {
    func panelStyle() -> some View {
        self
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(.white)
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    func sectionTitle() -> some View {
        self
            .font(.headline.weight(.bold))
            .foregroundStyle(.primary)
    }
}

#Preview {
    ContentView()
        .environmentObject(WorkoutViewModel())
}
