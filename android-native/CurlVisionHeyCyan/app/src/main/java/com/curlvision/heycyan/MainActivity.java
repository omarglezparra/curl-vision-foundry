package com.curlvision.heycyan;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int REQUEST_PERMISSIONS = 1200;
    private static final int REQUEST_VIDEO_PICKER = 1201;
    private static final String DEFAULT_BASE_URL = "http://192.168.4.1";
    private static final String PC_BRIDGE_URL = "http://10.0.2.2:8765";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final Map<String, BluetoothDevice> discoveredDevices = new LinkedHashMap<>();
    private final List<String> manifestFiles = new ArrayList<>();

    private LinearLayout deviceList;
    private LinearLayout advancedContainer;
    private LinearLayout workoutDashboard;
    private TextView statusText;
    private TextView connectionText;
    private TextView workoutText;
    private TextView repsText;
    private TextView timerText;
    private TextView setText;
    private TextView paceText;
    private TextView dashboardHintText;
    private TextView selectedVideoText;
    private TextView transferStatusText;
    private TextView logText;
    private Button connectButton;
    private Button startWorkoutButton;
    private Button finishWorkoutButton;
    private Button addRepButton;
    private Button undoRepButton;
    private Button newSetButton;
    private ProgressBar setProgressBar;
    private EditText baseUrlInput;
    private EditText azureInput;
    private EditText commandHexInput;

    private BluetoothLeScanner scanner;
    private BluetoothGatt connectedGatt;
    private BluetoothGattCharacteristic writableCharacteristic;
    private boolean scanning = false;
    private boolean workoutActive = false;
    private boolean advancedVisible = false;
    private boolean demoMode = false;
    private boolean pcBridgeConnected = false;
    private int currentSetReps = 0;
    private int totalReps = 0;
    private int setNumber = 1;
    private final int targetReps = 12;
    private long workoutStartedAtMs = 0L;
    private long lastRepAtMs = 0L;
    private String sessionId;
    private SelectedVideo selectedVideo;

    private final Runnable workoutTicker = new Runnable() {
        @Override
        public void run() {
            if (!workoutActive) {
                return;
            }
            updateWorkoutDashboard();
            mainHandler.postDelayed(this, 1000);
        }
    };

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            if (device == null) {
                return;
            }
            String address = safeDeviceAddress(device);
            if (!discoveredDevices.containsKey(address)) {
                discoveredDevices.put(address, device);
                runOnUiThread(MainActivity.this::renderDevices);
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            appendLog("BLE scan failed: " + errorCode);
            setStatus("Scan failed");
            scanning = false;
        }
    };

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            appendLog("GATT state changed status=" + status + " state=" + newState);
            if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                connectedGatt = gatt;
                setStatus("Lentes conectados");
                setConnectionMessage("Lentes conectados. Ya puedes empezar tu entrenamiento.");
                updateWorkoutButtons();
                if (hasConnectPermission()) {
                    gatt.discoverServices();
                }
            } else if (newState == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) {
                connectedGatt = null;
                writableCharacteristic = null;
                demoMode = false;
                pcBridgeConnected = false;
                setStatus("Lentes desconectados");
                setConnectionMessage("Prende tus lentes y mantenlos cerca del telefono.");
                updateWorkoutButtons();
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            appendLog("Services discovered: status=" + status);
            writableCharacteristic = findWritableCharacteristic(gatt);
            for (BluetoothGattService service : gatt.getServices()) {
                appendLog("Service " + service.getUuid());
                for (BluetoothGattCharacteristic characteristic : service.getCharacteristics()) {
                    appendLog("  Char " + characteristic.getUuid() + " props=" + characteristic.getProperties());
                    enableNotifyIfPossible(gatt, characteristic);
                }
            }
            setStatus("Lentes listos");
            setConnectionMessage("Conexion lista. Presiona Entrenar.");
            updateWorkoutButtons();
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            appendLog("Notify " + characteristic.getUuid() + ": " + bytesToHex(characteristic.getValue()));
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sessionId = "android_bv100_" + stamp();
        setContentView(buildContentView());
        requestRuntimePermissions();
        appendLog("Android app ready. Emulator can preview UI, but real BLE requires a physical Android phone.");
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacks(workoutTicker);
        stopBleScan();
        if (connectedGatt != null && hasConnectPermission()) {
            connectedGatt.close();
        }
        executor.shutdownNow();
        super.onDestroy();
    }

    private View buildContentView() {
        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        scrollView.setBackgroundColor(Color.rgb(245, 247, 249));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(16), dp(16), dp(24));
        scrollView.addView(root);

        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setPadding(dp(18), dp(18), dp(18), dp(18));
        hero.setBackground(makeRounded(Color.rgb(17, 24, 32)));
        root.addView(hero, matchWrap());

        TextView kicker = label("Blackview / HeyCyan", Color.rgb(130, 199, 255), 12, true);
        hero.addView(kicker);
        TextView title = label("Curl Vision Gym", Color.WHITE, 30, true);
        title.setPadding(0, dp(3), 0, dp(8));
        hero.addView(title);
        TextView subtitle = label("Ponte los lentes, conecta y empieza tu entrenamiento.", Color.rgb(218, 226, 234), 16, false);
        hero.addView(subtitle);

        statusText = label("Estado: iniciando", Color.WHITE, 14, true);
        statusText.setPadding(0, dp(12), 0, 0);
        hero.addView(statusText);

        root.addView(card("1. Conecta tus lentes", buildSimpleConnectPanel()), topMargin(14));
        root.addView(card("2. Entrena", buildSimpleWorkoutPanel()), topMargin(12));
        root.addView(card("3. Envia tu video al modelo", buildSimpleVideoPanel()), topMargin(12));

        Button advancedToggle = button("Opciones avanzadas", v -> toggleAdvanced());
        root.addView(advancedToggle, topMargin(12));

        advancedContainer = vertical();
        advancedContainer.setVisibility(View.GONE);
        advancedContainer.addView(card("Bluetooth tecnico", buildCommandPanel()), topMargin(12));
        advancedContainer.addView(card("Transferencia WiFi", buildTransferPanel()), topMargin(12));
        advancedContainer.addView(card("Diagnostico", buildLogPanel()), topMargin(12));
        root.addView(advancedContainer);

        return scrollView;
    }

    private View buildSimpleConnectPanel() {
        LinearLayout panel = vertical();
        connectionText = text("Prende tus lentes y mantenlos cerca del telefono.", 15);
        panel.addView(connectionText);
        connectButton = buttonWithColor("Conectar lentes", Color.rgb(32, 118, 210), v -> startBleScan());
        panel.addView(connectButton, topMargin(12));
        Button pcBridgeButton = buttonWithColor("Conectar usando la PC", Color.rgb(32, 118, 210), v -> connectViaPcBridge());
        panel.addView(pcBridgeButton, topMargin(8));
        Button demoButton = buttonWithColor("Ver modo demo", Color.rgb(46, 55, 64), v -> enableDemoMode());
        panel.addView(demoButton, topMargin(8));
        deviceList = vertical();
        panel.addView(deviceList, topMargin(10));
        renderDevices();
        return panel;
    }

    private View buildSimpleWorkoutPanel() {
        LinearLayout panel = vertical();
        workoutText = text("Cuando los lentes esten conectados, empieza tu serie de curls frente al espejo.", 15);
        panel.addView(workoutText);
        startWorkoutButton = buttonWithColor("Entrenar", Color.rgb(28, 141, 84), v -> startWorkoutSession());
        startWorkoutButton.setEnabled(false);
        panel.addView(startWorkoutButton, topMargin(12));
        finishWorkoutButton = buttonWithColor("Terminar entrenamiento", Color.rgb(46, 55, 64), v -> finishWorkoutSession());
        finishWorkoutButton.setEnabled(false);
        panel.addView(finishWorkoutButton, topMargin(8));
        panel.addView(buildWorkoutDashboard(), topMargin(12));
        updateWorkoutButtons();
        return panel;
    }

    private View buildWorkoutDashboard() {
        workoutDashboard = vertical();
        workoutDashboard.setPadding(dp(14), dp(14), dp(14), dp(14));
        workoutDashboard.setBackground(makeStroke(Color.rgb(250, 252, 253), Color.rgb(207, 216, 224)));
        workoutDashboard.setVisibility(View.GONE);

        TextView title = label("Dashboard en vivo", Color.rgb(32, 118, 210), 12, true);
        workoutDashboard.addView(title);

        LinearLayout statRow = horizontal();
        LinearLayout repsBox = vertical();
        repsText = label("0", Color.rgb(21, 26, 31), 46, true);
        TextView repsLabel = label("curls", Color.rgb(78, 90, 102), 14, true);
        repsBox.addView(repsText);
        repsBox.addView(repsLabel);
        statRow.addView(repsBox, weight());

        LinearLayout timeBox = vertical();
        timerText = label("00:00", Color.rgb(21, 26, 31), 30, true);
        TextView timeLabel = label("tiempo", Color.rgb(78, 90, 102), 14, true);
        timeBox.addView(timerText);
        timeBox.addView(timeLabel);
        statRow.addView(timeBox, weight());
        workoutDashboard.addView(statRow, topMargin(8));

        setText = label("Serie 1: 0 de 12", Color.rgb(42, 51, 60), 15, true);
        workoutDashboard.addView(setText, topMargin(10));

        setProgressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        setProgressBar.setMax(targetReps);
        setProgressBar.setProgress(0);
        workoutDashboard.addView(setProgressBar, topMargin(8));

        paceText = text("Ritmo: esperando primera curl", 14);
        workoutDashboard.addView(paceText, topMargin(10));

        dashboardHintText = text("Estado: mantente visible frente al espejo", 14);
        workoutDashboard.addView(dashboardHintText, topMargin(4));

        LinearLayout repRow = horizontal();
        addRepButton = buttonWithColor("+ Curl", Color.rgb(28, 141, 84), v -> addCurlRep());
        undoRepButton = buttonWithColor("Deshacer", Color.rgb(123, 135, 146), v -> undoCurlRep());
        repRow.addView(addRepButton, weight());
        repRow.addView(undoRepButton, weight());
        workoutDashboard.addView(repRow, topMargin(12));

        newSetButton = buttonWithColor("Nueva serie", Color.rgb(32, 118, 210), v -> startNewSet());
        workoutDashboard.addView(newSetButton, topMargin(8));
        return workoutDashboard;
    }

    private View buildSimpleVideoPanel() {
        LinearLayout panel = vertical();
        selectedVideoText = text("Video: ninguno", 14);
        panel.addView(selectedVideoText);
        panel.addView(buttonWithColor("Importar video de los lentes", Color.rgb(32, 118, 210), v -> pickVideo()), topMargin(12));
        azureInput = input("Azure container SAS URL", "");
        azureInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        panel.addView(azureInput, topMargin(10));
        panel.addView(buttonWithColor("Enviar al modelo", Color.rgb(28, 141, 84), v -> uploadSelectedVideo()), topMargin(10));
        return panel;
    }

    private void toggleAdvanced() {
        advancedVisible = !advancedVisible;
        advancedContainer.setVisibility(advancedVisible ? View.VISIBLE : View.GONE);
    }

    private View buildGlassesPanel() {
        LinearLayout panel = vertical();
        panel.addView(text("En telefono real: prende los lentes, abre permisos, escanea y conecta. En emulador usa Demo.", 13));

        LinearLayout row = horizontal();
        row.addView(button("Permisos", v -> requestRuntimePermissions()), weight());
        row.addView(button("Escanear BLE", v -> startBleScan()), weight());
        row.addView(button("Demo", v -> enableDemoMode()), weight());
        panel.addView(row, topMargin(10));

        deviceList = vertical();
        panel.addView(deviceList, topMargin(10));
        renderDevices();
        return panel;
    }

    private View buildCommandPanel() {
        LinearLayout panel = vertical();
        panel.addView(text("Start/stop real necesita los bytes BLE de HeyCyan/QCSDK. Cuando los tengamos, se pegan aqui y la app los manda al characteristic writable.", 13));
        commandHexInput = input("Comando HEX: AA 01 00 FF", "AA 01 00 FF");
        panel.addView(commandHexInput, topMargin(10));
        LinearLayout row = horizontal();
        row.addView(button("Enviar HEX", v -> sendHexCommand()), weight());
        row.addView(button("Desconectar", v -> disconnectGatt()), weight());
        panel.addView(row, topMargin(10));
        return panel;
    }

    private View buildTransferPanel() {
        LinearLayout panel = vertical();
        panel.addView(text("Conecta el telefono al WiFi de los lentes si HeyCyan los pone en modo transferencia. La app prueba endpoints comunes; si el fabricante expone stream o manifest, lo detecta.", 13));
        baseUrlInput = input("Base URL", DEFAULT_BASE_URL);
        panel.addView(baseUrlInput, topMargin(10));

        LinearLayout row = horizontal();
        row.addView(button("Probar stream", v -> probeLiveStream()), weight());
        row.addView(button("Manifest", v -> fetchManifest()), weight());
        row.addView(button("Descargar ultimo", v -> downloadNewest()), weight());
        panel.addView(row, topMargin(10));

        transferStatusText = text("Transferencia: esperando", 13);
        transferStatusText.setPadding(0, dp(8), 0, 0);
        panel.addView(transferStatusText);
        return panel;
    }

    private View buildDatasetPanel() {
        LinearLayout panel = vertical();
        selectedVideoText = text("Video: ninguno", 13);
        panel.addView(selectedVideoText);
        LinearLayout row = horizontal();
        row.addView(button("Importar video", v -> pickVideo()), weight());
        row.addView(button("Nueva sesion", v -> newSession()), weight());
        panel.addView(row, topMargin(10));
        azureInput = input("Azure container SAS URL", "");
        azureInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        panel.addView(azureInput, topMargin(10));
        panel.addView(button("Subir video + metadata", v -> uploadSelectedVideo()), topMargin(10));
        return panel;
    }

    private View buildLogPanel() {
        LinearLayout panel = vertical();
        logText = text("", 12);
        logText.setTextColor(Color.rgb(42, 51, 60));
        HorizontalScrollView horizontalScrollView = new HorizontalScrollView(this);
        horizontalScrollView.addView(logText);
        panel.addView(horizontalScrollView);
        return panel;
    }

    private LinearLayout card(String title, View content) {
        LinearLayout card = vertical();
        card.setPadding(dp(14), dp(14), dp(14), dp(14));
        card.setBackground(makeRounded(Color.WHITE));
        TextView titleView = label(title, Color.rgb(21, 26, 31), 18, true);
        card.addView(titleView);
        card.addView(content, topMargin(8));
        return card;
    }

    private void requestRuntimePermissions() {
        List<String> permissions = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissions.add(Manifest.permission.BLUETOOTH_SCAN);
            permissions.add(Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        List<String> missing = new ArrayList<>();
        for (String permission : permissions) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                missing.add(permission);
            }
        }
        if (!missing.isEmpty()) {
            requestPermissions(missing.toArray(new String[0]), REQUEST_PERMISSIONS);
            setStatus("Acepta permisos");
        } else {
            setStatus("Listo para conectar");
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_PERMISSIONS) {
            setStatus(hasScanPermission() ? "Listo para conectar" : "Faltan permisos");
        }
    }

    private boolean hasScanPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasConnectPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private void startBleScan() {
        if (!hasScanPermission()) {
            requestRuntimePermissions();
            return;
        }
        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            appendLog("Bluetooth is not available/enabled. Android emulator normally has no real BLE radio.");
            setStatus("Bluetooth apagado");
            setConnectionMessage("Enciende Bluetooth en el telefono y vuelve a intentar.");
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            appendLog("BLE scanner unavailable.");
            setStatus("Bluetooth no disponible");
            setConnectionMessage("Este dispositivo no puede escanear lentes BLE.");
            return;
        }
        discoveredDevices.clear();
        renderDevices();
        scanning = true;
        scanner.startScan(scanCallback);
        setStatus("Buscando lentes");
        setConnectionMessage("Buscando tus lentes Blackview/HeyCyan...");
        if (connectButton != null) {
            connectButton.setText("Buscando...");
            connectButton.setEnabled(false);
        }
        appendLog("Scanning for HeyCyan/BV100 devices...");
        mainHandler.postDelayed(this::stopBleScan, 12000);
    }

    private void stopBleScan() {
        boolean wasScanning = scanning;
        if (scanner != null && scanning && hasScanPermission()) {
            scanner.stopScan(scanCallback);
        }
        scanning = false;
        if (!wasScanning) {
            return;
        }
        if (connectButton != null) {
            connectButton.setText("Conectar lentes");
            connectButton.setEnabled(true);
        }
        setStatus(discoveredDevices.isEmpty() ? "No encontre lentes" : "Elige tus lentes");
        setConnectionMessage(discoveredDevices.isEmpty()
                ? "No encontre lentes. Prendelos, acercalos y toca Conectar lentes otra vez."
                : "Toca tus lentes en la lista para conectarlos.");
    }

    private void renderDevices() {
        if (deviceList == null) {
            return;
        }
        deviceList.removeAllViews();
        if (discoveredDevices.isEmpty()) {
            deviceList.addView(text(scanning ? "Buscando lentes..." : "Aun no hay lentes detectados.", 13));
            return;
        }
        for (BluetoothDevice device : discoveredDevices.values()) {
            String name = safeDeviceName(device);
            String address = safeDeviceAddress(device);
            Button button = buttonWithColor("Conectar a " + name + "\n" + address, Color.rgb(32, 118, 210), v -> connectDevice(device));
            button.setGravity(Gravity.CENTER_VERTICAL);
            deviceList.addView(button, topMargin(8));
        }
    }

    private void connectDevice(BluetoothDevice device) {
        if (!hasConnectPermission()) {
            requestRuntimePermissions();
            return;
        }
        stopBleScan();
        setStatus("Conectando lentes");
        setConnectionMessage("Conectando a " + safeDeviceName(device) + "...");
        appendLog("Connecting " + safeDeviceName(device) + " " + safeDeviceAddress(device));
        connectedGatt = device.connectGatt(this, false, gattCallback);
    }

    private void disconnectGatt() {
        if (connectedGatt != null && hasConnectPermission()) {
            connectedGatt.disconnect();
            connectedGatt.close();
        }
        connectedGatt = null;
        writableCharacteristic = null;
        demoMode = false;
        pcBridgeConnected = false;
        setStatus("Lentes desconectados");
        setConnectionMessage("Prende tus lentes y toca Conectar lentes.");
        updateWorkoutButtons();
    }

    private BluetoothGattCharacteristic findWritableCharacteristic(BluetoothGatt gatt) {
        for (BluetoothGattService service : gatt.getServices()) {
            for (BluetoothGattCharacteristic characteristic : service.getCharacteristics()) {
                int properties = characteristic.getProperties();
                if ((properties & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
                        || (properties & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) {
                    return characteristic;
                }
            }
        }
        return null;
    }

    private void enableNotifyIfPossible(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
        int properties = characteristic.getProperties();
        if ((properties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0 || !hasConnectPermission()) {
            return;
        }
        gatt.setCharacteristicNotification(characteristic, true);
        BluetoothGattDescriptor descriptor = characteristic.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
        if (descriptor != null) {
            descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            gatt.writeDescriptor(descriptor);
        }
    }

    private void sendHexCommand() {
        if (connectedGatt == null || writableCharacteristic == null || !hasConnectPermission()) {
            appendLog("No writable BLE connection. Connect lenses first.");
            setStatus("No writable BLE");
            return;
        }
        byte[] bytes;
        try {
            bytes = parseHex(commandHexInput.getText().toString());
        } catch (IllegalArgumentException error) {
            appendLog("Invalid HEX: " + error.getMessage());
            return;
        }
        boolean ok;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ok = connectedGatt.writeCharacteristic(writableCharacteristic, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS;
        } else {
            writableCharacteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            writableCharacteristic.setValue(bytes);
            ok = connectedGatt.writeCharacteristic(writableCharacteristic);
        }
        appendLog("Send HEX " + bytesToHex(bytes) + " -> " + ok);
        setStatus(ok ? "Command sent" : "Command failed");
    }

    private void enableDemoMode() {
        discoveredDevices.clear();
        demoMode = true;
        pcBridgeConnected = false;
        setStatus("Demo listo");
        setConnectionMessage("Modo demo activado. Puedes probar el flujo como si los lentes estuvieran conectados.");
        updateWorkoutButtons();
        appendLog("Demo device loaded. Emulator preview only: use a physical Android phone for real Bluetooth and glasses WiFi.");
        transferStatusText.setText("Transferencia: demo listo. Base URL " + DEFAULT_BASE_URL);
        selectedVideoText.setText("Video: demo_bv100_mirror.mp4 (metadata ready)");
    }

    private void connectViaPcBridge() {
        setStatus("Conectando por PC");
        setConnectionMessage("Buscando los lentes conectados al Bluetooth de Windows...");
        executor.execute(() -> {
            try {
                String response = getText(PC_BRIDGE_URL + "/connect");
                JSONObject payload = new JSONObject(response);
                if (!payload.optBoolean("ok", false)) {
                    throw new IOException(payload.optString("error", "PC bridge did not connect"));
                }
                String name = payload.optString("name", "BV100");
                String address = payload.optString("address", "");
                int serviceCount = payload.optInt("service_count", 0);
                pcBridgeConnected = true;
                demoMode = false;
                setStatus("Lentes conectados por PC");
                setConnectionMessage("Windows detecto " + name + " (" + address + ") con " + serviceCount + " servicios. Puedes empezar.");
                showDeviceListMessage(name + " conectado por el puente de Windows.");
                appendLog("PC bridge connected to " + name + " services=" + serviceCount);
                updateWorkoutButtons();
            } catch (Exception error) {
                pcBridgeConnected = false;
                setStatus("No conecto por PC");
                setConnectionMessage("No pude hablar con el puente PC. Verifica que windows_bv100_bridge.py este corriendo.");
                showDeviceListMessage("No pude conectar por el puente de Windows.");
                appendLog("PC bridge failed: " + error.getMessage());
                updateWorkoutButtons();
            }
        });
    }

    private void startWorkoutSession() {
        if (!demoMode && connectedGatt == null && !pcBridgeConnected) {
            toast("Primero conecta tus lentes.");
            setStatus("Conecta lentes primero");
            setConnectionMessage("Toca Conectar lentes antes de empezar.");
            return;
        }
        workoutActive = true;
        sessionId = "android_bv100_" + stamp();
        resetWorkoutMetrics();
        workoutStartedAtMs = System.currentTimeMillis();
        mainHandler.removeCallbacks(workoutTicker);
        mainHandler.post(workoutTicker);
        setStatus("Entrenamiento activo");
        if (workoutText != null) {
            workoutText.setText("Entrenamiento activo. Haz tus curls frente al espejo y manten tus brazos visibles.");
        }
        if (workoutDashboard != null) {
            workoutDashboard.setVisibility(View.VISIBLE);
        }
        updateWorkoutDashboard();
        updateWorkoutButtons();
        appendLog("Workout started: " + sessionId);
    }

    private void finishWorkoutSession() {
        workoutActive = false;
        mainHandler.removeCallbacks(workoutTicker);
        setStatus("Entrenamiento terminado");
        if (workoutText != null) {
            workoutText.setText("Resumen listo: " + totalReps + " curls en " + formatElapsed() + ". Importa el video de tus lentes y envialo al modelo.");
        }
        if (dashboardHintText != null) {
            dashboardHintText.setText("Estado: entrenamiento terminado");
        }
        updateWorkoutDashboard();
        updateWorkoutButtons();
        appendLog("Workout finished: " + sessionId + " total_reps=" + totalReps);
    }

    private void resetWorkoutMetrics() {
        currentSetReps = 0;
        totalReps = 0;
        setNumber = 1;
        lastRepAtMs = 0L;
    }

    private void addCurlRep() {
        if (!workoutActive) {
            toast("Empieza el entrenamiento primero.");
            return;
        }
        long now = System.currentTimeMillis();
        currentSetReps += 1;
        totalReps += 1;
        if (paceText != null) {
            if (lastRepAtMs == 0L) {
                paceText.setText("Ritmo: primera curl registrada");
            } else {
                long gapSeconds = Math.max((now - lastRepAtMs) / 1000L, 1L);
                paceText.setText("Ritmo: 1 curl cada " + gapSeconds + "s");
            }
        }
        lastRepAtMs = now;
        if (dashboardHintText != null) {
            dashboardHintText.setText(currentSetReps >= targetReps ? "Estado: meta de serie completa" : "Estado: buena serie, sigue controlado");
        }
        updateWorkoutDashboard();
    }

    private void undoCurlRep() {
        if (!workoutActive || totalReps == 0) {
            return;
        }
        totalReps = Math.max(totalReps - 1, 0);
        currentSetReps = Math.max(currentSetReps - 1, 0);
        if (paceText != null && totalReps == 0) {
            paceText.setText("Ritmo: esperando primera curl");
        }
        if (dashboardHintText != null) {
            dashboardHintText.setText("Estado: curl corregida");
        }
        updateWorkoutDashboard();
    }

    private void startNewSet() {
        if (!workoutActive) {
            toast("Empieza el entrenamiento primero.");
            return;
        }
        setNumber += 1;
        currentSetReps = 0;
        lastRepAtMs = 0L;
        if (paceText != null) {
            paceText.setText("Ritmo: esperando primera curl");
        }
        if (dashboardHintText != null) {
            dashboardHintText.setText("Estado: nueva serie lista");
        }
        updateWorkoutDashboard();
    }

    private void updateWorkoutDashboard() {
        runOnUiThread(() -> {
            if (repsText != null) {
                repsText.setText(String.valueOf(totalReps));
            }
            if (timerText != null) {
                timerText.setText(formatElapsed());
            }
            if (setText != null) {
                setText.setText("Serie " + setNumber + ": " + currentSetReps + " de " + targetReps);
            }
            if (setProgressBar != null) {
                setProgressBar.setProgress(Math.min(currentSetReps, targetReps));
            }
        });
    }

    private void showDeviceListMessage(String message) {
        runOnUiThread(() -> {
            if (deviceList == null) {
                return;
            }
            deviceList.removeAllViews();
            deviceList.addView(text(message, 13));
        });
    }

    private String formatElapsed() {
        long elapsedMs = workoutStartedAtMs == 0L ? 0L : Math.max(System.currentTimeMillis() - workoutStartedAtMs, 0L);
        long totalSeconds = elapsedMs / 1000L;
        long minutes = totalSeconds / 60L;
        long seconds = totalSeconds % 60L;
        return String.format(Locale.US, "%02d:%02d", minutes, seconds);
    }

    private void updateWorkoutButtons() {
        runOnUiThread(() -> {
            boolean ready = demoMode || connectedGatt != null || pcBridgeConnected;
            if (startWorkoutButton != null) {
                boolean canStart = ready && !workoutActive;
                startWorkoutButton.setEnabled(canStart);
                if (workoutActive) {
                    startWorkoutButton.setText("Entrenando...");
                    startWorkoutButton.setBackground(makeRounded(Color.rgb(28, 141, 84)));
                } else if (ready) {
                    startWorkoutButton.setText("Entrenar");
                    startWorkoutButton.setBackground(makeRounded(Color.rgb(28, 141, 84)));
                } else {
                    startWorkoutButton.setText("Conecta lentes primero");
                    startWorkoutButton.setBackground(makeRounded(Color.rgb(123, 135, 146)));
                }
            }
            if (finishWorkoutButton != null) {
                finishWorkoutButton.setEnabled(workoutActive);
                finishWorkoutButton.setBackground(makeRounded(workoutActive ? Color.rgb(46, 55, 64) : Color.rgb(123, 135, 146)));
            }
            if (addRepButton != null) {
                addRepButton.setEnabled(workoutActive);
            }
            if (undoRepButton != null) {
                undoRepButton.setEnabled(workoutActive);
            }
            if (newSetButton != null) {
                newSetButton.setEnabled(workoutActive);
            }
        });
    }

    private void probeLiveStream() {
        String baseUrl = cleanBaseUrl();
        setTransferStatus("Probando stream...");
        executor.execute(() -> {
            String[] paths = {"/stream", "/live", "/video", "/mjpeg", "/camera", "/api/stream"};
            StringBuilder result = new StringBuilder();
            for (String path : paths) {
                try {
                    HttpURLConnection connection = openConnection(baseUrl + path, "GET", 1600);
                    int code = connection.getResponseCode();
                    String type = connection.getContentType();
                    result.append(path).append(" -> ").append(code).append(" ").append(type == null ? "" : type).append("\n");
                    connection.disconnect();
                } catch (IOException error) {
                    result.append(path).append(" -> ").append(error.getClass().getSimpleName()).append("\n");
                }
            }
            appendLog(result.toString().trim());
            setTransferStatus("Probe terminado");
        });
    }

    private void fetchManifest() {
        setTransferStatus("Leyendo manifest...");
        executor.execute(() -> {
            try {
                String json = getText(cleanBaseUrl() + "/manifest.json");
                manifestFiles.clear();
                manifestFiles.addAll(extractManifestFiles(json));
                appendLog("Manifest files: " + manifestFiles);
                setTransferStatus(manifestFiles.isEmpty() ? "Manifest sin videos" : "Manifest: " + manifestFiles.size() + " videos");
            } catch (Exception error) {
                appendLog("Manifest failed: " + error.getMessage());
                setTransferStatus("Manifest fallo");
            }
        });
    }

    private void downloadNewest() {
        setTransferStatus("Descargando...");
        executor.execute(() -> {
            try {
                if (manifestFiles.isEmpty()) {
                    String json = getText(cleanBaseUrl() + "/manifest.json");
                    manifestFiles.clear();
                    manifestFiles.addAll(extractManifestFiles(json));
                }
                if (manifestFiles.isEmpty()) {
                    throw new IOException("No video entries found in manifest.json");
                }
                String filePath = manifestFiles.get(0);
                URL url = urlForMediaPath(filePath);
                File output = new File(getExternalFilesDir(Environment.DIRECTORY_MOVIES), safeFileName(filePath));
                downloadToFile(url, output);
                selectedVideo = SelectedVideo.fromFile(output, "android_blackview_wifi_download");
                updateSelectedVideoText();
                appendLog("Downloaded " + output.getAbsolutePath());
                setTransferStatus("Video descargado");
            } catch (Exception error) {
                appendLog("Download failed: " + error.getMessage());
                setTransferStatus("Descarga fallo");
            }
        });
    }

    private void pickVideo() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.setType("video/*");
        startActivityForResult(intent, REQUEST_VIDEO_PICKER);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_VIDEO_PICKER && resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri uri = data.getData();
            try {
                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException ignored) {
                appendLog("Video permission is session-only; upload it before closing the app.");
            }
            selectedVideo = SelectedVideo.fromUri(uri, displayName(uri), mimeType(uri), "android_video_picker_import");
            updateSelectedVideoText();
            appendLog("Imported video " + selectedVideo.name);
        }
    }

    private void uploadSelectedVideo() {
        if (selectedVideo == null) {
            toast("Importa o descarga un video primero.");
            return;
        }
        String sas = azureInput.getText().toString().trim();
        if (!sas.contains("?")) {
            toast("Pega el Azure container SAS URL.");
            return;
        }
        setStatus("Uploading dataset...");
        executor.execute(() -> {
            try {
                JSONObject metadata = metadataFor(selectedVideo);
                String videoBlob = metadata.getString("video_blob");
                String metadataBlob = metadata.getString("metadata_blob");
                uploadStream(sas, videoBlob, selectedVideo.open(this), selectedVideo.mimeType);
                uploadStream(sas, metadataBlob, new ByteArrayInputStream(metadata.toString(2).getBytes(StandardCharsets.UTF_8)), "application/json");
                appendLog("Azure upload complete: " + videoBlob);
                setStatus("Azure upload complete");
            } catch (Exception error) {
                appendLog("Azure upload failed: " + error.getMessage());
                setStatus("Azure upload failed");
            }
        });
    }

    private JSONObject metadataFor(SelectedVideo video) throws JSONException {
        String captureId = UUID.randomUUID().toString();
        String extension = extension(video.name);
        String videoFile = "video." + extension;
        String blobPrefix = "good_form/mirror_bv100/" + sessionId + "/" + captureId;
        JSONObject metadata = new JSONObject();
        metadata.put("capture_id", captureId);
        metadata.put("session_id", sessionId);
        metadata.put("workout_id", sessionId);
        metadata.put("label", "good_form");
        metadata.put("exercise", "biceps_curl");
        metadata.put("camera_angle", "mirror_bv100");
        metadata.put("capture_type", "set");
        metadata.put("drill_id", "android_blackview_bv100");
        metadata.put("drill_title", "Blackview BV100 Android");
        metadata.put("created_at", isoNow());
        metadata.put("source", video.source);
        metadata.put("source_filename", video.name);
        metadata.put("training_intent", "good_form_only");
        metadata.put("use_for_training", true);
        metadata.put("video_file", videoFile);
        metadata.put("video_file_extension", extension);
        metadata.put("video_mime_type", video.mimeType);
        metadata.put("azure_blob_prefix", blobPrefix);
        metadata.put("video_blob", blobPrefix + "/" + videoFile);
        metadata.put("metadata_blob", blobPrefix + "/metadata.json");
        return metadata;
    }

    private void uploadStream(String sasUrl, String blobName, InputStream inputStream, String contentType) throws IOException {
        HttpURLConnection connection = openConnection(blobUrl(sasUrl, blobName), "PUT", 30000);
        connection.setRequestProperty("x-ms-blob-type", "BlockBlob");
        connection.setRequestProperty("Content-Type", contentType);
        connection.setDoOutput(true);
        connection.setChunkedStreamingMode(1024 * 128);
        try (InputStream input = new BufferedInputStream(inputStream);
             OutputStream output = connection.getOutputStream()) {
            byte[] buffer = new byte[1024 * 64];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
        }
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IOException(blobName + " upload returned HTTP " + code + ": " + readError(connection));
        }
        connection.disconnect();
    }

    private String getText(String url) throws IOException {
        HttpURLConnection connection = openConnection(url, "GET", 5000);
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IOException("HTTP " + code);
        }
        try (InputStream input = connection.getInputStream()) {
            return new String(readAll(input), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private List<String> extractManifestFiles(String json) throws JSONException {
        List<String> files = new ArrayList<>();
        Object root = json.trim().startsWith("[") ? new JSONArray(json) : new JSONObject(json);
        if (root instanceof JSONArray) {
            extractArray((JSONArray) root, files);
        } else {
            JSONObject object = (JSONObject) root;
            if (object.has("files")) {
                extractArray(object.getJSONArray("files"), files);
            } else if (object.has("videos")) {
                extractArray(object.getJSONArray("videos"), files);
            }
        }
        return files;
    }

    private void extractArray(JSONArray array, List<String> files) throws JSONException {
        for (int i = 0; i < array.length(); i++) {
            Object entry = array.get(i);
            if (entry instanceof String) {
                files.add((String) entry);
            } else if (entry instanceof JSONObject) {
                JSONObject item = (JSONObject) entry;
                String value = firstString(item, "url", "path", "file", "filename", "name");
                if (!value.isEmpty()) {
                    files.add(value);
                }
            }
        }
    }

    private URL urlForMediaPath(String path) throws IOException {
        if (path.startsWith("http://") || path.startsWith("https://")) {
            return new URL(path);
        }
        String cleanPath = path.startsWith("/") ? path : "/files/" + path;
        return new URL(cleanBaseUrl() + cleanPath);
    }

    private void downloadToFile(URL url, File output) throws IOException {
        HttpURLConnection connection = openConnection(url.toString(), "GET", 30000);
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IOException("HTTP " + code);
        }
        File parent = output.getParentFile();
        if (parent != null) {
            parent.mkdirs();
        }
        try (InputStream input = new BufferedInputStream(connection.getInputStream());
             FileOutputStream fileOutput = new FileOutputStream(output)) {
            byte[] buffer = new byte[1024 * 64];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                fileOutput.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection openConnection(String url, String method, int timeoutMs) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(timeoutMs);
        connection.setReadTimeout(timeoutMs);
        connection.setUseCaches(false);
        return connection;
    }

    private String blobUrl(String sasUrl, String blobName) {
        String[] parts = sasUrl.split("\\?", 2);
        String base = parts[0].endsWith("/") ? parts[0].substring(0, parts[0].length() - 1) : parts[0];
        String query = parts.length > 1 ? parts[1] : "";
        String[] pathParts = blobName.split("/");
        StringBuilder encoded = new StringBuilder();
        for (int i = 0; i < pathParts.length; i++) {
            if (i > 0) {
                encoded.append("/");
            }
            encoded.append(Uri.encode(pathParts[i]));
        }
        return base + "/" + encoded + "?" + query;
    }

    private String cleanBaseUrl() {
        String value = baseUrlInput.getText().toString().trim();
        if (value.isEmpty()) {
            value = DEFAULT_BASE_URL;
        }
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private void newSession() {
        sessionId = "android_bv100_" + stamp();
        selectedVideo = null;
        updateSelectedVideoText();
        setStatus("New session " + sessionId);
        appendLog("New session: " + sessionId);
    }

    private void updateSelectedVideoText() {
        runOnUiThread(() -> selectedVideoText.setText(selectedVideo == null ? "Video: ninguno" : "Video: " + selectedVideo.name + " / " + selectedVideo.source));
    }

    private void setStatus(String message) {
        runOnUiThread(() -> statusText.setText("Estado: " + message));
    }

    private void setConnectionMessage(String message) {
        runOnUiThread(() -> {
            if (connectionText != null) {
                connectionText.setText(message);
            }
        });
    }

    private void setTransferStatus(String message) {
        runOnUiThread(() -> transferStatusText.setText("Transferencia: " + message));
    }

    private void appendLog(String message) {
        runOnUiThread(() -> {
            String line = "[" + new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date()) + "] " + message + "\n";
            logText.setText(line + logText.getText());
        });
    }

    private String safeDeviceName(BluetoothDevice device) {
        if (!hasConnectPermission()) {
            return "Bluetooth device";
        }
        String name = device.getName();
        return name == null || name.trim().isEmpty() ? "Unnamed BLE device" : name;
    }

    private String safeDeviceAddress(BluetoothDevice device) {
        if (!hasConnectPermission()) {
            return "permission-needed";
        }
        return device.getAddress();
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    return cursor.getString(index);
                }
            }
        }
        return "android_video_" + stamp() + ".mp4";
    }

    private String mimeType(Uri uri) {
        String type = getContentResolver().getType(uri);
        return type == null ? mimeForName(displayName(uri)) : type;
    }

    private String mimeForName(String name) {
        String ext = extension(name);
        if ("mov".equals(ext)) return "video/quicktime";
        if ("webm".equals(ext)) return "video/webm";
        if ("mkv".equals(ext)) return "video/x-matroska";
        if ("m4v".equals(ext)) return "video/x-m4v";
        return "video/mp4";
    }

    private String extension(String name) {
        int dot = name.lastIndexOf('.');
        if (dot >= 0 && dot + 1 < name.length()) {
            return name.substring(dot + 1).toLowerCase(Locale.US);
        }
        return "mp4";
    }

    private byte[] parseHex(String value) {
        String clean = value.replace("0x", "").replaceAll("[^0-9A-Fa-f]", "");
        if (clean.length() == 0 || clean.length() % 2 != 0) {
            throw new IllegalArgumentException("Use pairs like AA 01 FF");
        }
        byte[] bytes = new byte[clean.length() / 2];
        for (int i = 0; i < clean.length(); i += 2) {
            bytes[i / 2] = (byte) Integer.parseInt(clean.substring(i, i + 2), 16);
        }
        return bytes;
    }

    private String bytesToHex(byte[] bytes) {
        if (bytes == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        for (byte item : bytes) {
            if (builder.length() > 0) {
                builder.append(" ");
            }
            builder.append(String.format(Locale.US, "%02X", item));
        }
        return builder.toString();
    }

    private byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024 * 16];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private String readError(HttpURLConnection connection) {
        try (InputStream input = connection.getErrorStream()) {
            return input == null ? "" : new String(readAll(input), StandardCharsets.UTF_8);
        } catch (IOException error) {
            return "";
        }
    }

    private String firstString(JSONObject object, String... keys) {
        for (String key : keys) {
            String value = object.optString(key, "");
            if (!value.isEmpty()) {
                return value;
            }
        }
        return "";
    }

    private String safeFileName(String value) {
        String name = value.substring(value.lastIndexOf('/') + 1);
        if (name.trim().isEmpty()) {
            name = "bv100_" + stamp() + ".mp4";
        }
        return name.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private String stamp() {
        SimpleDateFormat format = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US);
        return format.format(new Date());
    }

    private String isoNow() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    private Button button(String label, View.OnClickListener listener) {
        return buttonWithColor(label, Color.rgb(32, 118, 210), listener);
    }

    private Button buttonWithColor(String label, int color, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(13);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(8), dp(8), dp(8), dp(8));
        button.setBackground(makeRounded(color));
        button.setOnClickListener(listener);
        return button;
    }

    private EditText input(String hint, String value) {
        EditText input = new EditText(this);
        input.setSingleLine(false);
        input.setMinLines(1);
        input.setHint(hint);
        input.setText(value);
        input.setTextSize(13);
        input.setTextColor(Color.rgb(21, 26, 31));
        input.setHintTextColor(Color.rgb(123, 135, 146));
        input.setPadding(dp(10), dp(8), dp(10), dp(8));
        input.setBackground(makeStroke(Color.WHITE, Color.rgb(188, 198, 208)));
        return input;
    }

    private TextView text(String value, int sp) {
        return label(value, Color.rgb(67, 78, 89), sp, false);
    }

    private TextView label(String value, int color, int sp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(sp);
        view.setLineSpacing(dp(1), 1.0f);
        if (bold) {
            view.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        }
        return view;
    }

    private LinearLayout vertical() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout horizontal() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        layout.setShowDividers(LinearLayout.SHOW_DIVIDER_MIDDLE);
        layout.setDividerPadding(dp(5));
        return layout;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams topMargin(int dpValue) {
        LinearLayout.LayoutParams params = matchWrap();
        params.topMargin = dp(dpValue);
        return params;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        params.leftMargin = dp(3);
        params.rightMargin = dp(3);
        return params;
    }

    private android.graphics.drawable.GradientDrawable makeRounded(int color) {
        android.graphics.drawable.GradientDrawable drawable = new android.graphics.drawable.GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(8));
        return drawable;
    }

    private android.graphics.drawable.GradientDrawable makeStroke(int color, int strokeColor) {
        android.graphics.drawable.GradientDrawable drawable = makeRounded(color);
        drawable.setStroke(dp(1), strokeColor);
        return drawable;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void toast(String message) {
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_SHORT).show());
    }

    private static final class SelectedVideo {
        final Uri uri;
        final File file;
        final String name;
        final String mimeType;
        final String source;

        private SelectedVideo(Uri uri, File file, String name, String mimeType, String source) {
            this.uri = uri;
            this.file = file;
            this.name = name;
            this.mimeType = mimeType;
            this.source = source;
        }

        static SelectedVideo fromUri(Uri uri, String name, String mimeType, String source) {
            return new SelectedVideo(uri, null, name, mimeType, source);
        }

        static SelectedVideo fromFile(File file, String source) {
            return new SelectedVideo(null, file, file.getName(), "video/mp4", source);
        }

        InputStream open(MainActivity activity) throws IOException {
            if (file != null) {
                return new FileInputStream(file);
            }
            return activity.getContentResolver().openInputStream(uri);
        }
    }
}
