import CoreBluetooth
import Foundation

@MainActor
final class GlassesBLEManager: NSObject, ObservableObject {
    @Published private(set) var bluetoothState: CBManagerState = .unknown
    @Published private(set) var devices: [GlassesDevice] = []
    @Published private(set) var connectedName: String = ""
    @Published private(set) var diagnosticLog: [String] = []

    private var central: CBCentralManager!
    private var peripherals: [UUID: CBPeripheral] = [:]
    private var connectedPeripheral: CBPeripheral?
    private var writableCharacteristic: CBCharacteristic?

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    func scan() {
        devices.removeAll()
        peripherals.removeAll()
        appendLog("Starting BLE scan")
        central.scanForPeripherals(withServices: nil, options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: false
        ])
    }

    func stopScan() {
        central.stopScan()
        appendLog("Stopped BLE scan")
    }

    func connect(to device: GlassesDevice) {
        guard let peripheral = peripherals[device.id] else {
            appendLog("Peripheral not found: \(device.name)")
            return
        }
        appendLog("Connecting to \(device.name)")
        central.connect(peripheral)
    }

    func disconnect() {
        guard let connectedPeripheral else { return }
        central.cancelPeripheralConnection(connectedPeripheral)
    }

    func sendRawCommand(_ data: Data) throws {
        guard let peripheral = connectedPeripheral,
              let characteristic = writableCharacteristic else {
            throw AppError.noWritableCharacteristic
        }
        peripheral.writeValue(data, for: characteristic, type: .withResponse)
        appendLog("Wrote \(data.count) bytes to \(characteristic.uuid.uuidString)")
    }

    func appendLog(_ message: String) {
        let line = "\(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium))  \(message)"
        diagnosticLog.append(line)
        if diagnosticLog.count > 120 {
            diagnosticLog.removeFirst(diagnosticLog.count - 120)
        }
    }

    private func upsertDevice(peripheral: CBPeripheral, rssi: NSNumber) {
        let name = peripheral.name ?? "Unknown glasses"
        let device = GlassesDevice(id: peripheral.identifier, name: name, rssi: rssi.intValue)
        peripherals[peripheral.identifier] = peripheral
        if let index = devices.firstIndex(where: { $0.id == device.id }) {
            devices[index] = device
        } else {
            devices.append(device)
        }
    }
}

extension GlassesBLEManager: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor in
            bluetoothState = central.state
            appendLog("Bluetooth state: \(central.state.rawValue)")
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        Task { @MainActor in
            upsertDevice(peripheral: peripheral, rssi: RSSI)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Task { @MainActor in
            connectedPeripheral = peripheral
            connectedName = peripheral.name ?? "HeyCyan glasses"
            appendLog("Connected to \(connectedName)")
            peripheral.delegate = self
            peripheral.discoverServices(nil)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        Task { @MainActor in
            appendLog("Failed to connect: \(error?.localizedDescription ?? "unknown")")
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        Task { @MainActor in
            appendLog("Disconnected: \(error?.localizedDescription ?? "clean")")
            connectedPeripheral = nil
            writableCharacteristic = nil
            connectedName = ""
        }
    }
}

extension GlassesBLEManager: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        Task { @MainActor in
            if let error {
                appendLog("Service discovery failed: \(error.localizedDescription)")
                return
            }
            for service in peripheral.services ?? [] {
                appendLog("Service \(service.uuid.uuidString)")
                peripheral.discoverCharacteristics(nil, for: service)
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        Task { @MainActor in
            if let error {
                appendLog("Characteristic discovery failed: \(error.localizedDescription)")
                return
            }
            for characteristic in service.characteristics ?? [] {
                appendLog("Characteristic \(characteristic.uuid.uuidString) properties=\(characteristic.properties.rawValue)")
                if characteristic.properties.contains(.notify) || characteristic.properties.contains(.indicate) {
                    peripheral.setNotifyValue(true, for: characteristic)
                }
                if writableCharacteristic == nil,
                   characteristic.properties.contains(.write) || characteristic.properties.contains(.writeWithoutResponse) {
                    writableCharacteristic = characteristic
                    appendLog("Writable candidate: \(characteristic.uuid.uuidString)")
                }
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        Task { @MainActor in
            if let error {
                appendLog("Notify error: \(error.localizedDescription)")
                return
            }
            let hex = characteristic.value?.map { String(format: "%02X", $0) }.joined(separator: " ") ?? ""
            appendLog("Notify \(characteristic.uuid.uuidString): \(hex)")
        }
    }
}
