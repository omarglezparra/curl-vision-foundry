import BluetoothSdk, { DeviceModels, type Device } from '@mentra/bluetooth-sdk';
import { useBluetoothEvent, useMentraBluetooth } from '@mentra/bluetooth-sdk/react';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

type CaptureState = 'idle' | 'preparing' | 'recording' | 'uploading' | 'error';
type CaptureOperation = 'none' | 'starting' | 'stopping' | 'resetting';
type RotationDegrees = 0 | 90 | 180 | 270;

type SessionPerformance = {
  sessionId: string;
  processedAt?: string;
  captures: number;
  reps: number;
  goodReps: number;
  goodFormPercent: number;
  avgRangeOfMotion: number;
  avgRepSpeed: number;
  warnings: string[];
};

type PerformanceResponse = {
  overall: {
    sessions: number;
    captures: number;
    reps: number;
    goodReps: number;
    goodFormPercent: number;
    avgRangeOfMotion: number;
    avgRepSpeed: number;
  };
  recentSessions: SessionPerformance[];
  pendingCaptures?: number;
};

type MentraCoachModalProps = {
  visible: boolean;
  onClose: () => void;
  sessionId: string;
};

const API_BASE_KEY = 'ai-javier-capture-api-base';
const UPLOAD_API_TOKEN_KEY = 'ai-javier-ingest-api-token';
const DASHBOARD_API_TOKEN_KEY = 'ai-javier-miniapp-api-token';
const DEFAULT_API_BASE = process.env.EXPO_PUBLIC_CAPTURE_API_BASE ?? '';
const MAX_SET_SECONDS = 170;
const OWNER_PROFILE_ID = 'owner';

function cleanApiBase(value: string) {
  return value.trim().replace(/\/$/, '');
}

function endpoint(apiBase: string, route: string) {
  const base = cleanApiBase(apiBase);
  if (!base) return '';
  return `${base}/${route.replace(/^\//, '')}`;
}

function captureWebhookUrl(
  apiBase: string,
  sessionId: string,
  captureId: string,
  rotationDegrees: RotationDegrees,
  sceneReflected: boolean,
  sourcePixelsMirrored: boolean
) {
  const url = new URL(endpoint(apiBase, 'mentra-video'));
  url.searchParams.set('session_id', sessionId);
  url.searchParams.set('capture_id', captureId);
  url.searchParams.set('profile_id', OWNER_PROFILE_ID);
  url.searchParams.set('exercise', 'biceps_curl');
  url.searchParams.set('camera_angle', sceneReflected ? 'head_worn_mirror' : 'head_worn_direct');
  url.searchParams.set('arm', 'auto');
  url.searchParams.set('rotation_degrees', String(rotationDegrees));
  url.searchParams.set('scene_reflected', String(sceneReflected));
  url.searchParams.set('source_pixels_mirrored', String(sourcePixelsMirrored));
  return url.toString();
}

function formatDuration(seconds: number) {
  const clean = Math.max(Math.floor(seconds), 0);
  return `${Math.floor(clean / 60)}:${String(clean % 60).padStart(2, '0')}`;
}

function formatNumber(value: number, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

async function requestBluetoothPermissions() {
  if (Platform.OS !== 'android') {
    return { bluetoothAllowed: true, locationGranted: true };
  }

  const androidVersion = Number(Platform.Version);
  const coarseLocationPermission = PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
  const locationPermission = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
  const bluetoothPermissions = androidVersion >= 31
    ? [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]
    : [locationPermission];
  const requestedPermissions = androidVersion >= 31
    ? [...bluetoothPermissions, coarseLocationPermission, locationPermission]
    : bluetoothPermissions;
  const result = await PermissionsAndroid.requestMultiple(requestedPermissions);
  return {
    bluetoothAllowed: bluetoothPermissions.every(
      (permission) => result[permission] === PermissionsAndroid.RESULTS.GRANTED
    ),
    locationGranted: result[locationPermission] === PermissionsAndroid.RESULTS.GRANTED,
  };
}

export default function MentraCoachModal({ visible, onClose, sessionId }: MentraCoachModalProps) {
  const mentra = useMentraBluetooth({
    defaultModel: DeviceModels.MentraLive,
    scanTimeoutMs: 10_000,
  });
  const [tab, setTab] = useState<'capture' | 'dashboard'>('capture');
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [statusMessage, setStatusMessage] = useState('Conecta Mentra Live para comenzar.');
  const [recordingStartedAt, setRecordingStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [setsRecorded, setSetsRecorded] = useState(0);
  const [rotationDegrees, setRotationDegrees] = useState<RotationDegrees>(0);
  const [sceneReflected, setSceneReflected] = useState(true);
  const [sourcePixelsMirrored, setSourcePixelsMirrored] = useState(false);
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [uploadApiToken, setUploadApiToken] = useState('');
  const [dashboardApiToken, setDashboardApiToken] = useState('');
  const [performance, setPerformance] = useState<PerformanceResponse | null>(null);
  const [performanceLoading, setPerformanceLoading] = useState(false);
  const [performanceError, setPerformanceError] = useState('');
  const captureStateRef = useRef<CaptureState>('idle');
  const captureOperationRef = useRef<CaptureOperation>('none');
  const activeRequestIdRef = useRef('');
  const visibleRef = useRef(visible);
  const cameraPrepared = useRef(false);

  const connected = mentra.glasses.connected;
  const ready = connected && mentra.glasses.ready;
  const battery = connected ? mentra.glasses.battery.level : null;
  const recordingSeconds = recordingStartedAt ? (now - recordingStartedAt) / 1000 : 0;
  const canRecord = ready && captureState === 'idle';

  function transitionCaptureState(nextState: CaptureState) {
    captureStateRef.current = nextState;
    setCaptureState(nextState);
  }

  function setActiveRequest(requestId: string) {
    activeRequestIdRef.current = requestId;
  }

  function clearActiveCapture() {
    setActiveRequest('');
    setRecordingStartedAt(0);
  }

  function hasProtectedCapture() {
    const state = captureStateRef.current;
    return (
      captureOperationRef.current !== 'none' ||
      state === 'preparing' ||
      state === 'recording' ||
      state === 'uploading' ||
      Boolean(activeRequestIdRef.current)
    );
  }

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    Promise.all([
      SecureStore.getItemAsync(API_BASE_KEY),
      SecureStore.getItemAsync(UPLOAD_API_TOKEN_KEY),
      SecureStore.getItemAsync(DASHBOARD_API_TOKEN_KEY),
    ])
      .then(([savedBase, savedUploadToken, savedDashboardToken]) => {
        if (savedBase) setApiBase(savedBase);
        if (savedUploadToken) setUploadApiToken(savedUploadToken);
        if (savedDashboardToken) setDashboardApiToken(savedDashboardToken);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (captureState !== 'recording') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [captureState]);

  useEffect(() => {
    if (captureState !== 'recording' || !recordingStartedAt) return undefined;
    const remainingMs = Math.max(
      MAX_SET_SECONDS * 1000 - (Date.now() - recordingStartedAt),
      0
    );
    const timer = setTimeout(() => void stopSet(), remainingMs);
    return () => clearTimeout(timer);
  }, [captureState, recordingStartedAt]);

  useEffect(() => {
    if (connected) return;
    cameraPrepared.current = false;
    if (hasProtectedCapture()) {
      captureOperationRef.current = 'none';
      transitionCaptureState('error');
      setStatusMessage(
        'Se perdió la conexión durante la captura. Reconecta las gafas y toca Restablecer captura antes de continuar.'
      );
    }
  }, [connected]);

  useBluetoothEvent('video_recording_status', (event) => {
    const activeRequestId = activeRequestIdRef.current;
    if (!activeRequestId || !event.requestId || event.requestId !== activeRequestId) return;

    if (!event.success) {
      captureOperationRef.current = 'none';
      transitionCaptureState('error');
      setStatusMessage(
        `${event.details || `Mentra error: ${event.status}`} Toca Restablecer captura para volver a intentarlo.`
      );
      return;
    }
    if (event.status === 'recording_started') {
      setStatusMessage('Grabando la serie desde Mentra Live.');
    } else if (event.status === 'recording_stopped') {
      if (captureOperationRef.current === 'stopping') {
        setStatusMessage('Serie detenida; finalizando la subida.');
      } else if (captureOperationRef.current === 'resetting') {
        setStatusMessage('Grabación detenida; restableciendo la captura.');
      } else if (
        captureStateRef.current === 'recording' ||
        captureStateRef.current === 'preparing'
      ) {
        captureOperationRef.current = 'none';
        clearActiveCapture();
        transitionCaptureState('error');
        setStatusMessage(
          'Mentra detuvo la grabación antes de subirla, posiblemente por batería, espacio o una interrupción. El video quedó solo en las gafas; toca Restablecer captura para continuar.'
        );
      }
    }
  });

  useBluetoothEvent('button_press', (event) => {
    if (!visibleRef.current || event.pressType !== 'long') return;
    if (captureStateRef.current === 'recording') {
      void stopSet();
    } else if (captureStateRef.current === 'idle') {
      void startSet();
    }
  });

  const connectionLabel = useMemo(() => {
    if (ready) return 'Mentra lista';
    if (connected) return 'Conectada, iniciando';
    if (mentra.scan.active) return 'Buscando';
    return 'Desconectada';
  }, [connected, mentra.scan.active, ready]);

  async function scan() {
    setStatusMessage('Solicitando permiso Bluetooth...');
    const permissions = await requestBluetoothPermissions();
    if (!permissions.bluetoothAllowed) {
      setStatusMessage('Permiso Bluetooth denegado.');
      return;
    }
    setStatusMessage(
      permissions.locationGranted
        ? 'Buscando Mentra Live cercana...'
        : 'Buscando Mentra Live. Si no aparece, concede Ubicación precisa y activa los servicios de ubicación.'
    );
    try {
      const devices = await mentra.scan.start(DeviceModels.MentraLive);
      setStatusMessage(
        devices.length
          ? 'Selecciona tus gafas.'
          : 'No encontré Mentra Live. En algunos Android 12+ debes conceder Ubicación precisa y activar los servicios de ubicación antes de buscar.'
      );
    } catch (error) {
      setStatusMessage(`Error de búsqueda: ${String(error)}`);
    }
  }

  async function connect(device: Device) {
    setStatusMessage(`Conectando ${device.name}...`);
    try {
      await mentra.connect(device, { saveAsDefault: true });
      await mentra.setGalleryModeEnabled(false);
      setStatusMessage('Mentra conectada. Pulsación larga también inicia o detiene una serie.');
    } catch (error) {
      setStatusMessage(`No pude conectar: ${String(error)}`);
    }
  }

  async function prepareCamera() {
    if (cameraPrepared.current) return;
    setStatusMessage('Preparando cámara amplia para verte en el espejo...');
    await mentra.setGalleryModeEnabled(false);
    await BluetoothSdk.setCameraFov({ fov: 118, roiPosition: 'bottom' });
    cameraPrepared.current = true;
  }

  async function startSet() {
    if (
      !ready ||
      captureStateRef.current !== 'idle' ||
      captureOperationRef.current !== 'none'
    ) return;

    captureOperationRef.current = 'starting';
    transitionCaptureState('preparing');
    try {
      await prepareCamera();
      const requestId = `ml1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setActiveRequest(requestId);
      await BluetoothSdk.startVideoRecording(requestId, true, true, {
        width: 1280,
        height: 720,
        fps: 30,
        maxRecordingTimeMinutes: 4,
      });
      const startedAt = Date.now();
      setRecordingStartedAt(startedAt);
      setNow(startedAt);
      captureOperationRef.current = 'none';
      transitionCaptureState('recording');
      setStatusMessage('Grabando. Mantén pulsado el botón de las gafas para detener.');
    } catch (error) {
      captureOperationRef.current = 'none';
      transitionCaptureState('error');
      setStatusMessage(`No pude iniciar la cámara: ${String(error)}. Toca Restablecer captura.`);
    }
  }

  async function stopSet() {
    const requestId = activeRequestIdRef.current;
    if (
      captureStateRef.current !== 'recording' ||
      captureOperationRef.current !== 'none'
    ) return false;
    if (!requestId) {
      transitionCaptureState('error');
      setStatusMessage('Falta el identificador de la grabación. Toca Restablecer captura.');
      return false;
    }

    captureOperationRef.current = 'stopping';
    transitionCaptureState('uploading');
    setStatusMessage('Deteniendo y subiendo la serie...');
    try {
      const base = cleanApiBase(apiBase);
      if (base && uploadApiToken) {
        const uploadUrl = captureWebhookUrl(
          base,
          sessionId,
          requestId,
          rotationDegrees,
          sceneReflected,
          sourcePixelsMirrored
        );
        await BluetoothSdk.stopVideoRecording(requestId, uploadUrl, uploadApiToken);
        setStatusMessage('Serie guardada en Azure; el dashboard mostrará “pendiente” hasta procesarla.');
      } else {
        await BluetoothSdk.stopVideoRecording(requestId);
        setStatusMessage('Serie guardada en las gafas. Configura Azure para analizarla.');
      }
      setSetsRecorded((count) => count + 1);
      clearActiveCapture();
      captureOperationRef.current = 'none';
      transitionCaptureState('idle');
      if (base && dashboardApiToken) void loadPerformance();
      return true;
    } catch (error) {
      captureOperationRef.current = 'none';
      transitionCaptureState('error');
      setStatusMessage(`No pude finalizar la serie: ${String(error)}. Toca Restablecer captura.`);
      return false;
    }
  }

  async function resetCapture() {
    if (captureOperationRef.current !== 'none') {
      setStatusMessage(
        'Mentra todavía está terminando una operación. Espera un momento y vuelve a tocar Restablecer captura.'
      );
      return;
    }

    const requestId = activeRequestIdRef.current;
    captureOperationRef.current = 'resetting';
    transitionCaptureState('preparing');
    setStatusMessage('Restableciendo el estado de captura...');
    try {
      if (requestId && connected) {
        try {
          await BluetoothSdk.stopVideoRecording(requestId);
        } catch {
          // The recording may already be stopped after an upload or device error.
        }
      }
    } finally {
      clearActiveCapture();
      captureOperationRef.current = 'none';
      transitionCaptureState('idle');
      setStatusMessage(
        'Captura restablecida. Confirma que el indicador de grabación de las gafas esté apagado antes de iniciar otra serie.'
      );
    }
  }

  function handleClose() {
    if (!hasProtectedCapture()) {
      onClose();
      return;
    }

    setTab('capture');
    if (captureStateRef.current === 'recording') {
      setStatusMessage(
        'Para no perder esta serie, toca Detener serie y espera a que termine la subida antes de cerrar.'
      );
    } else if (captureStateRef.current === 'error') {
      setStatusMessage('Toca Restablecer captura antes de cerrar para dejar la cámara en un estado seguro.');
    } else {
      setStatusMessage('Espera a que Mentra termine la operación de cámara antes de cerrar.');
    }
  }

  async function handleDisconnect() {
    if (hasProtectedCapture()) {
      setTab('capture');
      setStatusMessage(
        captureStateRef.current === 'recording'
          ? 'Detén la serie y espera a que termine la subida antes de desconectar las gafas.'
          : 'Espera a que termine la operación o toca Restablecer captura antes de desconectar las gafas.'
      );
      return;
    }

    try {
      await mentra.disconnect();
      setStatusMessage('Mentra Live desconectada.');
    } catch (error) {
      setStatusMessage(`No pude desconectar las gafas: ${String(error)}`);
    }
  }

  async function saveConnection() {
    try {
      const base = cleanApiBase(apiBase);
      if (base) await SecureStore.setItemAsync(API_BASE_KEY, base);
      else await SecureStore.deleteItemAsync(API_BASE_KEY);
      if (uploadApiToken) {
        await SecureStore.setItemAsync(UPLOAD_API_TOKEN_KEY, uploadApiToken);
      } else {
        await SecureStore.deleteItemAsync(UPLOAD_API_TOKEN_KEY);
      }
      if (dashboardApiToken) {
        await SecureStore.setItemAsync(DASHBOARD_API_TOKEN_KEY, dashboardApiToken);
      } else {
        await SecureStore.deleteItemAsync(DASHBOARD_API_TOKEN_KEY);
      }
      setApiBase(base);
      setStatusMessage('Conexión privada guardada en el llavero del teléfono.');
    } catch (error) {
      setStatusMessage(`No pude guardar la conexión: ${String(error)}`);
    }
  }

  async function loadPerformance() {
    const url = endpoint(apiBase, 'performance');
    if (!url || !dashboardApiToken) {
      setPerformanceError('Guarda la URL de Azure y el token de lectura para cargar el dashboard.');
      return;
    }
    setPerformanceLoading(true);
    setPerformanceError('');
    try {
      const response = await fetch(`${url}?limit=12&profile_id=${OWNER_PROFILE_ID}`, {
        headers: { Authorization: `Bearer ${dashboardApiToken}` },
      });
      if (!response.ok) throw new Error(`dashboard ${response.status}`);
      setPerformance((await response.json()) as PerformanceResponse);
    } catch (error) {
      setPerformanceError(String(error));
    } finally {
      setPerformanceLoading(false);
    }
  }

  function cycleRotation() {
    setRotationDegrees((current) => ((current + 90) % 360) as RotationDegrees);
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <View>
            <Text style={styles.kicker}>Mentra Live · ml1</Text>
            <Text style={styles.title}>AI Javier Coach</Text>
          </View>
          <Pressable style={styles.closeButton} onPress={handleClose}>
            <Text style={styles.closeText}>Cerrar</Text>
          </Pressable>
        </View>

        <View style={styles.tabs}>
          <Pressable style={[styles.tab, tab === 'capture' && styles.tabActive]} onPress={() => setTab('capture')}>
            <Text style={[styles.tabText, tab === 'capture' && styles.tabTextActive]}>Entrenar</Text>
          </Pressable>
          <Pressable
            style={[styles.tab, tab === 'dashboard' && styles.tabActive]}
            onPress={() => {
              setTab('dashboard');
              void loadPerformance();
            }}
          >
            <Text style={[styles.tabText, tab === 'dashboard' && styles.tabTextActive]}>Rendimiento</Text>
          </Pressable>
        </View>

        {tab === 'capture' ? (
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.heroCard}>
              <View>
                <Text style={styles.heroLabel}>{connectionLabel}</Text>
                <Text style={styles.heroValue}>{battery === null ? '--' : `${battery}% batería`}</Text>
              </View>
              <View style={[styles.dot, ready && styles.dotReady, captureState === 'recording' && styles.dotRecording]} />
            </View>

            {!connected ? (
              <View style={styles.card}>
                <Pressable style={styles.primaryButton} onPress={scan} disabled={mentra.scan.active}>
                  <Text style={styles.primaryText}>{mentra.scan.active ? 'Buscando...' : 'Buscar Mentra Live'}</Text>
                </Pressable>
                {mentra.scan.devices.map((device) => (
                  <Pressable key={device.id} style={styles.deviceRow} onPress={() => connect(device)}>
                    <View>
                      <Text style={styles.deviceName}>{device.name}</Text>
                      <Text style={styles.deviceMeta}>{device.model}</Text>
                    </View>
                    <Text style={styles.connectText}>Conectar</Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <View style={styles.recordCard}>
                <Text style={styles.recordEyebrow}>Sesión {sessionId}</Text>
                <Text style={styles.timer}>
                  {captureState === 'recording' ? formatDuration(recordingSeconds) : `${setsRecorded} series`}
                </Text>
                <Text style={styles.status}>{statusMessage}</Text>
                {captureState === 'error' ? (
                  <Pressable style={styles.resetButton} onPress={resetCapture}>
                    <Text style={styles.recordText}>Restablecer captura</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[styles.recordButton, captureState === 'recording' && styles.stopButton]}
                    disabled={!canRecord && captureState !== 'recording'}
                    onPress={captureState === 'recording' ? stopSet : startSet}
                  >
                    {captureState === 'preparing' || captureState === 'uploading' ? (
                      <ActivityIndicator color="#ffffff" />
                    ) : (
                      <Text style={styles.recordText}>{captureState === 'recording' ? 'Detener serie' : 'Grabar serie'}</Text>
                    )}
                  </Pressable>
                )}
                <Text style={styles.hint}>También puedes mantener pulsado el botón de Mentra Live.</Text>
                <Pressable style={styles.disconnectButton} onPress={handleDisconnect}>
                  <Text style={styles.disconnectText}>Desconectar gafas</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Espejo y rotación</Text>
              <Text style={styles.cardCopy}>Se aplican al análisis, no a la vista previa.</Text>
              <View style={styles.settingRow}>
                <View>
                  <Text style={styles.settingTitle}>Estoy frente al espejo</Text>
                  <Text style={styles.settingCopy}>Corrige la lateralidad de tu reflejo</Text>
                </View>
                <Switch value={sceneReflected} onValueChange={setSceneReflected} />
              </View>
              <View style={styles.settingRow}>
                <View>
                  <Text style={styles.settingTitle}>Archivo ya invertido</Text>
                  <Text style={styles.settingCopy}>Normalmente permanece apagado</Text>
                </View>
                <Switch value={sourcePixelsMirrored} onValueChange={setSourcePixelsMirrored} />
              </View>
              <Pressable style={styles.rotationButton} onPress={cycleRotation}>
                <Text style={styles.rotationLabel}>Giro horario para dejar el video vertical</Text>
                <Text style={styles.rotationValue}>{rotationDegrees}°</Text>
              </Pressable>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Azure privado</Text>
              <TextInput
                style={styles.input}
                value={apiBase}
                onChangeText={setApiBase}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://...azurewebsites.net/api"
                placeholderTextColor="#76818c"
              />
              <TextInput
                style={styles.input}
                value={uploadApiToken}
                onChangeText={setUploadApiToken}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                placeholder="Token privado de subida"
                placeholderTextColor="#76818c"
              />
              <TextInput
                style={styles.input}
                value={dashboardApiToken}
                onChangeText={setDashboardApiToken}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                placeholder="Token privado de lectura"
                placeholderTextColor="#76818c"
              />
              <Pressable style={styles.secondaryButton} onPress={saveConnection}>
                <Text style={styles.secondaryText}>Guardar conexión segura</Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.dashboardHeader}>
              <View>
                <Text style={styles.cardTitle}>Tu rendimiento</Text>
                <Text style={styles.cardCopy}>Datos procesados de todas tus sesiones.</Text>
              </View>
              <Pressable style={styles.refreshButton} onPress={loadPerformance}>
                <Text style={styles.refreshText}>Actualizar</Text>
              </Pressable>
            </View>
            {performanceLoading ? <ActivityIndicator color="#2076d2" size="large" /> : null}
            {performanceError ? <Text style={styles.errorText}>{performanceError}</Text> : null}
            {performance ? (
              <>
                <View style={styles.metricsGrid}>
                  <Metric label="Sesiones" value={String(performance.overall.sessions)} />
                  <Metric label="Reps" value={String(performance.overall.reps)} />
                  <Metric label="Buena forma" value={`${formatNumber(performance.overall.goodFormPercent)}%`} />
                  <Metric label="ROM promedio" value={`${formatNumber(performance.overall.avgRangeOfMotion)}°`} />
                </View>
                {performance.pendingCaptures ? (
                  <Text style={styles.pendingText}>{performance.pendingCaptures} capturas pendientes de análisis</Text>
                ) : null}
                {performance.recentSessions.map((session) => (
                  <View key={session.sessionId} style={styles.sessionCard}>
                    <View style={styles.sessionHeader}>
                      <Text style={styles.sessionTitle}>{session.sessionId}</Text>
                      <Text style={styles.sessionScore}>{formatNumber(session.goodFormPercent)}%</Text>
                    </View>
                    <Text style={styles.sessionMeta}>
                      {session.reps} reps · {session.goodReps} limpias · ROM {formatNumber(session.avgRangeOfMotion)}°
                    </Text>
                    {session.warnings.length ? <Text style={styles.warningText}>{session.warnings.join(' · ')}</Text> : null}
                  </View>
                ))}
              </>
            ) : null}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f3f6f8' },
  header: { backgroundColor: '#101820', paddingHorizontal: 20, paddingVertical: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kicker: { color: '#72d6a3', fontSize: 12, fontWeight: '900', textTransform: 'uppercase' },
  title: { color: '#ffffff', fontSize: 24, fontWeight: '900', marginTop: 3 },
  closeButton: { borderWidth: 1, borderColor: '#53616e', borderRadius: 8, paddingHorizontal: 13, paddingVertical: 9 },
  closeText: { color: '#ffffff', fontWeight: '800' },
  tabs: { flexDirection: 'row', backgroundColor: '#101820', paddingHorizontal: 20, gap: 8, paddingBottom: 14 },
  tab: { flex: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center', backgroundColor: '#25313b' },
  tabActive: { backgroundColor: '#2076d2' },
  tabText: { color: '#aeb9c3', fontWeight: '800' },
  tabTextActive: { color: '#ffffff' },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  heroCard: { borderRadius: 12, backgroundColor: '#101820', padding: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroLabel: { color: '#ffffff', fontSize: 21, fontWeight: '900' },
  heroValue: { color: '#aeb9c3', marginTop: 4, fontWeight: '700' },
  dot: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#75818b' },
  dotReady: { backgroundColor: '#47c889' },
  dotRecording: { backgroundColor: '#ff4d4d' },
  card: { borderRadius: 12, backgroundColor: '#ffffff', padding: 16 },
  primaryButton: { minHeight: 50, borderRadius: 9, backgroundColor: '#2076d2', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#ffffff', fontWeight: '900', fontSize: 16 },
  deviceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#e6ebef', paddingVertical: 14 },
  deviceName: { color: '#17202a', fontWeight: '900', fontSize: 16 },
  deviceMeta: { color: '#67727d', marginTop: 3 },
  connectText: { color: '#2076d2', fontWeight: '900' },
  recordCard: { borderRadius: 12, backgroundColor: '#101820', padding: 20, alignItems: 'center' },
  recordEyebrow: { color: '#9aa7b2', fontWeight: '800', fontSize: 12 },
  timer: { color: '#ffffff', fontWeight: '900', fontSize: 52, marginTop: 8 },
  status: { color: '#c7d0d8', textAlign: 'center', lineHeight: 20, minHeight: 40, marginVertical: 10 },
  recordButton: { alignSelf: 'stretch', minHeight: 58, borderRadius: 10, backgroundColor: '#2076d2', alignItems: 'center', justifyContent: 'center' },
  stopButton: { backgroundColor: '#d83a3a' },
  resetButton: { alignSelf: 'stretch', minHeight: 58, borderRadius: 10, backgroundColor: '#b56500', alignItems: 'center', justifyContent: 'center' },
  recordText: { color: '#ffffff', fontSize: 18, fontWeight: '900' },
  hint: { color: '#92a0ac', fontSize: 12, marginTop: 12, textAlign: 'center' },
  disconnectButton: { marginTop: 14, paddingVertical: 8 },
  disconnectText: { color: '#c7d0d8', fontWeight: '800' },
  cardTitle: { color: '#17202a', fontSize: 19, fontWeight: '900' },
  cardCopy: { color: '#68747f', fontSize: 13, lineHeight: 18, marginTop: 3, marginBottom: 10 },
  settingRow: { borderTopWidth: 1, borderTopColor: '#e8edf1', paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingTitle: { color: '#27313b', fontWeight: '800', fontSize: 14 },
  settingCopy: { color: '#76818c', fontSize: 12, marginTop: 2 },
  rotationButton: { borderTopWidth: 1, borderTopColor: '#e8edf1', paddingTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rotationLabel: { color: '#27313b', fontWeight: '800' },
  rotationValue: { color: '#2076d2', fontSize: 24, fontWeight: '900' },
  input: { borderWidth: 1, borderColor: '#cbd3da', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11, marginTop: 10, color: '#17202a' },
  secondaryButton: { minHeight: 46, borderRadius: 8, backgroundColor: '#e5eef7', alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  secondaryText: { color: '#1e5f9f', fontWeight: '900' },
  dashboardHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 },
  refreshButton: { backgroundColor: '#e2ebf4', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  refreshText: { color: '#1e5f9f', fontWeight: '900' },
  errorText: { borderRadius: 8, backgroundColor: '#ffe4e4', color: '#9f2f2f', padding: 12, fontWeight: '700' },
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metricCard: { width: '48%', borderRadius: 12, backgroundColor: '#ffffff', padding: 16 },
  metricValue: { color: '#17202a', fontSize: 30, fontWeight: '900' },
  metricLabel: { color: '#68747f', fontSize: 12, fontWeight: '800', marginTop: 5, textTransform: 'uppercase' },
  pendingText: { borderRadius: 8, backgroundColor: '#fff1cf', color: '#7b5500', padding: 12, fontWeight: '800' },
  sessionCard: { borderRadius: 12, backgroundColor: '#ffffff', padding: 15 },
  sessionHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  sessionTitle: { flex: 1, color: '#17202a', fontWeight: '900' },
  sessionScore: { color: '#18825c', fontSize: 20, fontWeight: '900' },
  sessionMeta: { color: '#66727e', marginTop: 8, lineHeight: 19 },
  warningText: { color: '#9a5a00', marginTop: 8, fontWeight: '700' },
});
