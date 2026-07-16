import { CameraView, useCameraPermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Drill = {
  id: string;
  exercise: string;
  label: string;
  angle: string;
  captureType: string;
  title: string;
  target: string;
  cues: string[];
};

type SessionClip = {
  id: string;
  source: 'iphone_camera' | 'bv100_photos';
  drillId: string;
  drillTitle: string;
  exercise: string;
  label: string;
  angle: string;
  captureType: string;
  startedAt: string;
  savedAt: string;
  durationSeconds: number;
  assetDurationSeconds: number;
  assetId: string;
  assetUri: string;
  localUri: string;
  filename: string;
  width: number;
  height: number;
  repsDetected: number | null;
  uploadStatus: 'local' | 'uploading' | 'uploaded' | 'failed';
  uploadError: string;
  uploadedAt: string;
  videoMimeType: string;
};

type MediaAsset = Awaited<ReturnType<typeof MediaLibrary.getAssetsAsync>>['assets'][number];

const DRILLS: Drill[] = [
  {
    id: 'good_curl_front',
    exercise: 'biceps_curl',
    label: 'good_form',
    angle: 'front',
    captureType: 'set',
    title: 'Curl limpio - frente',
    target: '1 serie completa con tecnica buena',
    cues: ['Camara al frente', 'Torso quieto', 'Hombro estable', 'Rango completo'],
  },
  {
    id: 'good_curl_45',
    exercise: 'biceps_curl',
    label: 'good_form',
    angle: '45_degrees',
    captureType: 'set',
    title: 'Curl limpio - 45 grados',
    target: '1 serie completa con tecnica buena',
    cues: ['Camara a 45 grados', 'Codo visible', 'Muneca visible', 'Tempo controlado'],
  },
  {
    id: 'good_curl_side',
    exercise: 'biceps_curl',
    label: 'good_form',
    angle: 'side',
    captureType: 'set',
    title: 'Curl limpio - lateral',
    target: '1 serie completa con tecnica buena',
    cues: ['Camara lateral', 'Brazo completo visible', 'Rango completo', 'Sin balanceo'],
  },
  {
    id: 'good_workout_full',
    exercise: 'full_workout',
    label: 'good_form',
    angle: 'mixed',
    captureType: 'full_session',
    title: 'Sesion gym completa',
    target: 'Graba tu entrenamiento limpio completo',
    cues: ['Solo reps buenas', 'Cambia angulo si hace falta', 'Mantente visible', 'Pausa si hay dolor'],
  },
];

const BV100_DRILL: Drill = {
  id: 'heycyan_bv100_mirror_auto',
  exercise: 'biceps_curl',
  label: 'good_form',
  angle: 'mirror_bv100',
  captureType: 'set',
  title: 'HeyCyan BV100 auto',
  target: 'Videos nuevos desde Fotos',
  cues: ['HeyCyan', 'Espejo', 'Brazo completo visible', 'Auto import'],
};

const VIDEO_MIME_TYPES: Record<string, string> = {
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wmv: 'video/x-ms-wmv',
};

function workoutStamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/-/g, '').replace('T', '_').replace(/:/g, '');
}

function createWorkoutId() {
  return `gym_good_${workoutStamp()}`;
}

function createCaptureId() {
  return `clip_${workoutStamp()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDuration(seconds: number) {
  const cleanSeconds = Math.max(Math.floor(seconds), 0);
  const hours = Math.floor(cleanSeconds / 3600);
  const minutes = Math.floor((cleanSeconds % 3600) / 60);
  const rest = cleanSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatDateTime(value: Date | string) {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values)).join(', ') || 'None yet';
}

function extensionForFilename(filename: string) {
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension && extension !== filename.toLowerCase() ? extension : 'mp4';
}

function mimeTypeForFilename(filename: string) {
  return VIDEO_MIME_TYPES[extensionForFilename(filename)] ?? 'video/mp4';
}

function cleanSasUrl(value: string) {
  return value.trim();
}

function blobUrl(containerSasUrl: string, blobName: string) {
  const [baseUrl, query] = cleanSasUrl(containerSasUrl).split('?');
  const cleanBase = baseUrl.replace(/\/$/, '');
  const encodedPath = blobName.split('/').map(encodeURIComponent).join('/');
  return `${cleanBase}/${encodedPath}?${query}`;
}

function buildMetadata(clip: SessionClip, sessionId: string) {
  const extension = extensionForFilename(clip.filename);
  const videoFile = `video.${extension}`;
  const blobPrefix = `${clip.label}/${clip.angle}/${sessionId}/${clip.id}`;

  return {
    capture_id: clip.id,
    session_id: sessionId,
    workout_id: sessionId,
    label: clip.label,
    exercise: clip.exercise,
    camera_angle: clip.angle,
    capture_type: clip.captureType,
    drill_id: clip.drillId,
    drill_title: clip.drillTitle,
    duration_seconds: clip.durationSeconds,
    recording_started_at: clip.startedAt,
    created_at: clip.savedAt,
    source: clip.source === 'bv100_photos' ? 'heycyan_bv100_iphone_photos_auto_import' : 'iphone_expo_camera',
    source_asset_id: clip.assetId,
    source_filename: clip.filename,
    training_intent: clip.label === 'good_form' ? 'good_form_only' : 'mixed',
    use_for_training: clip.exercise === 'biceps_curl',
    video_file: videoFile,
    video_mime_type: clip.videoMimeType,
    azure_blob_prefix: blobPrefix,
    video_blob: `${blobPrefix}/${videoFile}`,
    metadata_blob: `${blobPrefix}/metadata.json`,
  };
}

export default function App() {
  const cameraRef = useRef<CameraView>(null);
  const recordingPromise = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const recordingStartedAt = useRef<Date | null>(null);
  const recordingDrill = useRef<Drill | null>(null);
  const seenBv100AssetIds = useRef<Set<string>>(new Set());
  const bv100ScanInProgress = useRef(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [workoutId, setWorkoutId] = useState(createWorkoutId);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => new Date());
  const [recording, setRecording] = useState(false);
  const [savedClips, setSavedClips] = useState(0);
  const [lastClipUri, setLastClipUri] = useState('');
  const [sessionClips, setSessionClips] = useState<SessionClip[]>([]);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [azureSasUrl, setAzureSasUrl] = useState('');
  const [autoUpload, setAutoUpload] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [autoImportEnabled, setAutoImportEnabled] = useState(false);
  const [bv100Status, setBv100Status] = useState('HeyCyan listo');

  const selectedDrill = DRILLS[selectedIndex];
  const sessionId = useMemo(() => workoutId, [workoutId]);
  const totalRecordedSeconds = useMemo(
    () => sessionClips.reduce((total, clip) => total + clip.durationSeconds, 0),
    [sessionClips]
  );
  const sessionElapsedSeconds = Math.max((now - sessionStartedAt.getTime()) / 1000, 0);
  const currentRecordingSeconds = recordingStartedAt.current
    ? Math.max((now - recordingStartedAt.current.getTime()) / 1000, 0)
    : 0;
  const repsDetected = sessionClips.reduce(
    (total, clip) => total + (clip.repsDetected ?? 0),
    0
  );
  const latestClip = sessionClips[sessionClips.length - 1];
  const anglesCaptured = uniqueValues(sessionClips.map((clip) => clip.angle));
  const labelsCaptured = uniqueValues(sessionClips.map((clip) => `${clip.exercise}/${clip.label}`));

  const hasCameraPermission = cameraPermission?.granted;
  const hasMediaPermission = mediaPermission?.granted;

  useEffect(() => {
    if (!recording && !detailsVisible) {
      return undefined;
    }

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [detailsVisible, recording]);

  useEffect(() => {
    if (!autoImportEnabled || !hasMediaPermission) {
      return undefined;
    }

    scanBv100Videos(false);
    const timer = setInterval(() => {
      scanBv100Videos(false);
    }, 6000);

    return () => clearInterval(timer);
  }, [autoImportEnabled, hasMediaPermission, autoUpload, azureSasUrl, workoutId]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && autoImportEnabled && hasMediaPermission) {
        scanBv100Videos(false);
      }
    });

    return () => subscription.remove();
  }, [autoImportEnabled, hasMediaPermission, autoUpload, azureSasUrl, workoutId]);

  async function requestPermissions() {
    await requestCameraPermission();
    await requestMediaPermission();
  }

  async function latestVideoAssets() {
    const page = await MediaLibrary.getAssetsAsync({
      first: 80,
      mediaType: MediaLibrary.MediaType.VIDEO,
      sortBy: [['creationTime', false]],
    });
    return [...page.assets].sort((first, second) => first.creationTime - second.creationTime);
  }

  async function primeBv100SeenAssets() {
    const assets = await latestVideoAssets();
    assets.forEach((asset) => seenBv100AssetIds.current.add(asset.id));
  }

  async function toggleBv100AutoImport() {
    if (!hasMediaPermission) {
      await requestMediaPermission();
    }

    if (autoImportEnabled) {
      setAutoImportEnabled(false);
      setBv100Status('HeyCyan pausado');
      return;
    }

    await primeBv100SeenAssets();
    setAutoImportEnabled(true);
    setBv100Status('Esperando videos nuevos');
  }

  async function scanBv100Videos(includeExisting: boolean) {
    if (bv100ScanInProgress.current) {
      return;
    }

    bv100ScanInProgress.current = true;
    try {
      const assets = await latestVideoAssets();
      const candidates = assets.filter((asset) => {
        if (seenBv100AssetIds.current.has(asset.id)) {
          return false;
        }
        return includeExisting || asset.creationTime >= sessionStartedAt.getTime();
      });

      if (candidates.length === 0) {
        setBv100Status(autoImportEnabled ? 'Esperando videos nuevos' : 'Sin videos nuevos');
        return;
      }

      for (const asset of candidates) {
        seenBv100AssetIds.current.add(asset.id);
        await importBv100Asset(asset);
      }
    } catch (error) {
      setBv100Status(`Error HeyCyan: ${String(error)}`);
    } finally {
      bv100ScanInProgress.current = false;
    }
  }

  async function importBv100Asset(asset: MediaAsset) {
    const info = await MediaLibrary.getAssetInfoAsync(asset);
    const savedAt = new Date();
    const createdAt = new Date(asset.creationTime || savedAt.getTime());
    const localUri = info.localUri || asset.uri;
    const filename = asset.filename || `heycyan_bv100_${workoutStamp(createdAt)}.mp4`;
    const clip: SessionClip = {
      id: createCaptureId(),
      source: 'bv100_photos',
      drillId: BV100_DRILL.id,
      drillTitle: BV100_DRILL.title,
      exercise: BV100_DRILL.exercise,
      label: BV100_DRILL.label,
      angle: BV100_DRILL.angle,
      captureType: BV100_DRILL.captureType,
      startedAt: createdAt.toISOString(),
      savedAt: savedAt.toISOString(),
      durationSeconds: Number((asset.duration || 0).toFixed(2)),
      assetDurationSeconds: Number((asset.duration || 0).toFixed(2)),
      assetId: asset.id,
      assetUri: asset.uri,
      localUri,
      filename,
      width: asset.width,
      height: asset.height,
      repsDetected: null,
      uploadStatus: 'local',
      uploadError: '',
      uploadedAt: '',
      videoMimeType: mimeTypeForFilename(filename),
    };

    setSavedClips((count) => count + 1);
    setLastClipUri(localUri);
    setSessionClips((clips) => [...clips, clip]);
    setBv100Status(`Importado: ${filename}`);

    if (autoUpload && cleanSasUrl(azureSasUrl)) {
      await uploadClipToAzure(clip);
    }
  }

  function updateClipUpload(id: string, values: Partial<SessionClip>) {
    setSessionClips((clips) =>
      clips.map((clip) => (clip.id === id ? { ...clip, ...values } : clip))
    );
  }

  async function putBlob(blobName: string, blob: Blob, contentType: string) {
    const response = await fetch(blobUrl(azureSasUrl, blobName), {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': contentType,
      },
      body: blob,
    });
    if (!response.ok) {
      throw new Error(`${blobName} upload ${response.status}`);
    }
  }

  async function uploadClipToAzure(clip: SessionClip) {
    if (!cleanSasUrl(azureSasUrl)) {
      setBv100Status('Azure SAS pendiente');
      return;
    }

    updateClipUpload(clip.id, { uploadStatus: 'uploading', uploadError: '' });
    setBv100Status(`Subiendo: ${clip.filename}`);
    try {
      const metadata = buildMetadata(clip, sessionId);
      const videoResponse = await fetch(clip.localUri);
      const videoBlob = await videoResponse.blob();
      const metadataBlob = new Blob([JSON.stringify(metadata, null, 2)], {
        type: 'application/json',
      });

      await putBlob(metadata.video_blob, videoBlob, clip.videoMimeType);
      await putBlob(metadata.metadata_blob, metadataBlob, 'application/json');

      updateClipUpload(clip.id, {
        uploadStatus: 'uploaded',
        uploadedAt: new Date().toISOString(),
        uploadError: '',
      });
      setUploadCount((count) => count + 1);
      setBv100Status(`Azure listo: ${clip.filename}`);
    } catch (error) {
      const message = String(error);
      updateClipUpload(clip.id, { uploadStatus: 'failed', uploadError: message });
      setBv100Status(`Fallo Azure: ${message}`);
    }
  }

  async function uploadPendingClips() {
    const pending = sessionClips.filter((clip) => clip.uploadStatus !== 'uploaded');
    for (const clip of pending) {
      await uploadClipToAzure(clip);
    }
  }

  async function startRecording() {
    if (!cameraRef.current || recording) {
      return;
    }
    if (!hasMediaPermission) {
      await requestMediaPermission();
    }

    const startedAt = new Date();
    recordingStartedAt.current = startedAt;
    recordingDrill.current = selectedDrill;
    setNow(startedAt.getTime());
    setRecording(true);
    recordingPromise.current = cameraRef.current.recordAsync({
      maxDuration: selectedDrill.captureType === 'full_session' ? 900 : 180,
    });

    recordingPromise.current
      .then(async (video) => {
        if (!video?.uri) {
          return;
        }
        const asset = await MediaLibrary.createAssetAsync(video.uri);
        await MediaLibrary.createAlbumAsync('Curl Vision Foundry', asset, false);
        const savedAt = new Date();
        const clipDrill = recordingDrill.current ?? selectedDrill;
        const started = recordingStartedAt.current ?? savedAt;
        const durationSeconds = Math.max((savedAt.getTime() - started.getTime()) / 1000, 0);
        const clip: SessionClip = {
          id: createCaptureId(),
          source: 'iphone_camera',
          drillId: clipDrill.id,
          drillTitle: clipDrill.title,
          exercise: clipDrill.exercise,
          label: clipDrill.label,
          angle: clipDrill.angle,
          captureType: clipDrill.captureType,
          startedAt: started.toISOString(),
          savedAt: savedAt.toISOString(),
          durationSeconds: Number(durationSeconds.toFixed(2)),
          assetDurationSeconds: Number(asset.duration.toFixed(2)),
          assetId: asset.id,
          assetUri: asset.uri,
          localUri: video.uri,
          filename: asset.filename,
          width: asset.width,
          height: asset.height,
          repsDetected: null,
          uploadStatus: 'local',
          uploadError: '',
          uploadedAt: '',
          videoMimeType: mimeTypeForFilename(asset.filename),
        };
        setSavedClips((count) => count + 1);
        setLastClipUri(video.uri);
        setSessionClips((clips) => [...clips, clip]);
        if (autoUpload && cleanSasUrl(azureSasUrl)) {
          await uploadClipToAzure(clip);
        }
      })
      .catch((error) => {
        Alert.alert('Recording failed', String(error));
      })
      .finally(() => {
        setRecording(false);
        recordingStartedAt.current = null;
        recordingDrill.current = null;
        recordingPromise.current = null;
      });
  }

  function stopRecording() {
    cameraRef.current?.stopRecording();
  }

  function nextDrill() {
    setSelectedIndex((index) => (index + 1) % DRILLS.length);
  }

  function previousDrill() {
    setSelectedIndex((index) => (index === 0 ? DRILLS.length - 1 : index - 1));
  }

  function newSession() {
    if (recording) {
      return;
    }
    setWorkoutId(createWorkoutId());
    setSessionStartedAt(new Date());
    setSavedClips(0);
    setLastClipUri('');
    setSessionClips([]);
    setUploadCount(0);
    seenBv100AssetIds.current = new Set();
    setAutoImportEnabled(false);
    setBv100Status('HeyCyan listo');
    setDetailsVisible(false);
    setNow(Date.now());
  }

  if (!hasCameraPermission || !hasMediaPermission) {
    return (
      <SafeAreaView style={styles.permissionScreen}>
        <StatusBar style="light" />
        <Text style={styles.appTitle}>Curl Vision Foundry</Text>
        <Text style={styles.permissionTitle}>Permisos necesarios</Text>
        <Text style={styles.permissionText}>
          La app necesita camara frontal y permiso de Fotos para guardar clips y tomar videos nuevos
          que lleguen desde HeyCyan/BV100.
        </Text>
        <Pressable style={styles.primaryButton} onPress={requestPermissions}>
          <Text style={styles.primaryButtonText}>Activar permisos</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.cameraArea}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing="front"
          mode="video"
          mute
          mirror
        />
        <View style={styles.cameraOverlay}>
          <View>
            <Text style={styles.overlayLabel}>Good-form capture</Text>
            <Text style={styles.overlayTitle}>{selectedDrill.title}</Text>
          </View>
          <View style={[styles.recordingDot, recording && styles.recordingDotActive]} />
        </View>
        <View style={styles.cameraFooter}>
          <Text style={styles.cameraFooterText}>
            {recording ? 'recording' : 'recorded'} {formatDuration(recording ? currentRecordingSeconds : totalRecordedSeconds)}
          </Text>
          <Text style={styles.cameraFooterText}>{savedClips} clips</Text>
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.progressRow}>
          {DRILLS.map((drill, index) => (
            <Pressable
              key={drill.id}
              style={[styles.stepDot, index === selectedIndex && styles.stepDotActive]}
              onPress={() => setSelectedIndex(index)}
              disabled={recording}
            />
          ))}
        </View>

        <View style={styles.drillHeader}>
          <View>
            <Text style={styles.drillTitle}>{selectedDrill.title}</Text>
            <Text style={styles.drillTarget}>{selectedDrill.target}</Text>
          </View>
          <Text style={styles.drillCounter}>
            {selectedIndex + 1}/{DRILLS.length}
          </Text>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.cueScroller}>
          {selectedDrill.cues.map((cue) => (
            <View key={cue} style={styles.cuePill}>
              <Text style={styles.cueText}>{cue}</Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.metadata}>
          <Text style={styles.metadataText}>session_id: {sessionId}</Text>
          <Text style={styles.metadataText}>
            label: {selectedDrill.exercise} / {selectedDrill.label} / {selectedDrill.angle}
          </Text>
          <Text style={styles.metadataText}>clips saved: {savedClips}</Text>
          <Text style={styles.metadataText}>video time: {formatDuration(totalRecordedSeconds)}</Text>
          <Text style={styles.metadataText}>reps detected: {repsDetected || 'AI pending'}</Text>
          <Text style={styles.metadataText}>azure uploads: {uploadCount}</Text>
          <Text style={styles.metadataText}>bv100: {bv100Status}</Text>
        </View>

        <View style={styles.bv100Panel}>
          <View style={styles.bv100Header}>
            <View>
              <Text style={styles.bv100Title}>HeyCyan BV100</Text>
              <Text style={styles.bv100Status}>{autoImportEnabled ? 'Auto import activo' : 'Auto import pausado'}</Text>
            </View>
            <View style={[styles.statusPill, autoImportEnabled && styles.statusPillActive]}>
              <Text style={[styles.statusPillText, autoImportEnabled && styles.statusPillTextActive]}>
                {autoImportEnabled ? 'ON' : 'OFF'}
              </Text>
            </View>
          </View>

          <TextInput
            style={styles.sasInput}
            value={azureSasUrl}
            onChangeText={setAzureSasUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Azure container SAS URL"
            placeholderTextColor="#7b8792"
          />

          <View style={styles.bv100ButtonRow}>
            <Pressable style={styles.bv100Button} onPress={toggleBv100AutoImport}>
              <Text style={styles.bv100ButtonText}>{autoImportEnabled ? 'Pausar HeyCyan' : 'Auto HeyCyan'}</Text>
            </Pressable>
            <Pressable style={styles.bv100Button} onPress={() => scanBv100Videos(true)}>
              <Text style={styles.bv100ButtonText}>Importar recientes</Text>
            </Pressable>
          </View>

          <View style={styles.bv100ButtonRow}>
            <Pressable
              style={[styles.bv100Button, autoUpload && styles.bv100ButtonActive]}
              onPress={() => setAutoUpload((enabled) => !enabled)}
            >
              <Text style={[styles.bv100ButtonText, autoUpload && styles.bv100ButtonTextActive]}>
                {autoUpload ? 'Auto upload ON' : 'Auto upload OFF'}
              </Text>
            </Pressable>
            <Pressable style={styles.bv100Button} onPress={uploadPendingClips}>
              <Text style={styles.bv100ButtonText}>Subir pendientes</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.buttonRow}>
          <Pressable style={styles.secondaryButton} onPress={previousDrill} disabled={recording}>
            <Text style={styles.secondaryButtonText}>Anterior</Text>
          </Pressable>
          <Pressable
            style={[styles.recordButton, recording && styles.stopButton]}
            onPress={recording ? stopRecording : startRecording}
          >
            <Text style={styles.recordButtonText}>
              {recording
                ? 'Detener'
                : selectedDrill.captureType === 'full_session'
                  ? 'Grabar sesion'
                  : 'Grabar set'}
            </Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={nextDrill} disabled={recording}>
            <Text style={styles.secondaryButtonText}>Siguiente</Text>
          </Pressable>
        </View>

        <Pressable style={styles.sessionButton} onPress={newSession} disabled={recording}>
          <Text style={styles.secondaryButtonText}>Nueva sesion</Text>
        </Pressable>

        <Pressable style={styles.detailsButton} onPress={() => setDetailsVisible(true)}>
          <Text style={styles.detailsButtonText}>Detalles de sesion</Text>
        </Pressable>

        {lastClipUri ? <Text style={styles.savedText}>Ultimo clip guardado en Fotos</Text> : null}
      </View>

      <Modal
        animationType="slide"
        presentationStyle="pageSheet"
        visible={detailsVisible}
        onRequestClose={() => setDetailsVisible(false)}
      >
        <SafeAreaView style={styles.detailsScreen}>
          <View style={styles.detailsHeader}>
            <View style={styles.detailsHeaderCopy}>
              <Text style={styles.detailsKicker}>Session report</Text>
              <Text style={styles.detailsTitle}>Curl Vision Foundry</Text>
            </View>
            <Pressable style={styles.closeButton} onPress={() => setDetailsVisible(false)}>
              <Text style={styles.closeButtonText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.detailsContent}>
            <View style={styles.summaryGrid}>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>Elapsed</Text>
                <Text style={styles.summaryValue}>{formatDuration(sessionElapsedSeconds)}</Text>
              </View>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>Video time</Text>
                <Text style={styles.summaryValue}>{formatDuration(totalRecordedSeconds)}</Text>
              </View>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>Clips</Text>
                <Text style={styles.summaryValue}>{savedClips}</Text>
              </View>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>Reps</Text>
                <Text style={styles.summaryValue}>{repsDetected || 'Pending'}</Text>
              </View>
            </View>

            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Session</Text>
              <Text style={styles.detailLine}>session_id: {sessionId}</Text>
              <Text style={styles.detailLine}>started: {formatDateTime(sessionStartedAt)}</Text>
              <Text style={styles.detailLine}>
                current recording: {recording ? formatDuration(currentRecordingSeconds) : 'No'}
              </Text>
              <Text style={styles.detailLine}>labels: {labelsCaptured}</Text>
              <Text style={styles.detailLine}>angles: {anglesCaptured}</Text>
              <Text style={styles.detailLine}>azure uploads: {uploadCount}</Text>
              <Text style={styles.detailLine}>bv100: {bv100Status}</Text>
              <Text style={styles.detailLine}>rep source: pose analysis pending</Text>
            </View>

            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Active drill</Text>
              <Text style={styles.detailLine}>title: {selectedDrill.title}</Text>
              <Text style={styles.detailLine}>exercise: {selectedDrill.exercise}</Text>
              <Text style={styles.detailLine}>label: {selectedDrill.label}</Text>
              <Text style={styles.detailLine}>angle: {selectedDrill.angle}</Text>
              <Text style={styles.detailLine}>target: {selectedDrill.target}</Text>
            </View>

            {latestClip ? (
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Latest video</Text>
                <Text style={styles.detailLine}>file: {latestClip.filename}</Text>
                <Text style={styles.detailLine}>source: {latestClip.source}</Text>
                <Text style={styles.detailLine}>upload: {latestClip.uploadStatus}</Text>
                <Text style={styles.detailLine}>
                  length: {formatDuration(latestClip.durationSeconds)} recorded /{' '}
                  {formatDuration(latestClip.assetDurationSeconds)} asset
                </Text>
                <Text style={styles.detailLine}>
                  resolution: {latestClip.width}x{latestClip.height}
                </Text>
                <Text style={styles.detailLine}>saved: {formatDateTime(latestClip.savedAt)}</Text>
                <Text style={styles.detailLine}>asset_id: {latestClip.assetId}</Text>
              </View>
            ) : null}

            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Clips</Text>
              {sessionClips.length === 0 ? (
                <Text style={styles.detailLine}>No videos saved in this session yet.</Text>
              ) : (
                sessionClips.map((clip, index) => (
                  <View key={clip.id} style={styles.clipRow}>
                    <Text style={styles.clipTitle}>
                      {index + 1}. {clip.drillTitle}
                    </Text>
                    <Text style={styles.detailLine}>
                      {formatDuration(clip.durationSeconds)} | {clip.exercise} | {clip.angle}
                    </Text>
                    <Text style={styles.detailLine}>file: {clip.filename}</Text>
                    <Text style={styles.detailLine}>source: {clip.source}</Text>
                    <Text style={styles.detailLine}>upload: {clip.uploadStatus}</Text>
                    <Text style={styles.detailLine}>saved: {formatDateTime(clip.savedAt)}</Text>
                    {clip.uploadError ? <Text style={styles.detailLine}>error: {clip.uploadError}</Text> : null}
                  </View>
                ))
              )}
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#101316',
  },
  permissionScreen: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#101316',
  },
  appTitle: {
    color: '#72d6a3',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 28,
    textTransform: 'uppercase',
  },
  permissionTitle: {
    color: '#f3f5f7',
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 12,
  },
  permissionText: {
    color: '#c8d0d8',
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 28,
  },
  cameraArea: {
    flex: 1,
    minHeight: 420,
    backgroundColor: '#050607',
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    position: 'absolute',
    top: 18,
    left: 18,
    right: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  overlayLabel: {
    color: '#d7dde3',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  overlayTitle: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '800',
    marginTop: 2,
  },
  recordingDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#5c6670',
  },
  recordingDotActive: {
    backgroundColor: '#ff4d4d',
  },
  cameraFooter: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cameraFooterText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
    backgroundColor: 'rgba(7, 10, 13, 0.62)',
    borderRadius: 8,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  panel: {
    backgroundColor: '#f5f7f9',
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 18,
  },
  progressRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  stepDot: {
    flex: 1,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#c8d0d8',
  },
  stepDotActive: {
    backgroundColor: '#2076d2',
  },
  drillHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  drillTitle: {
    color: '#151a1f',
    fontSize: 24,
    fontWeight: '800',
  },
  drillTarget: {
    color: '#59636e',
    fontSize: 15,
    fontWeight: '600',
    marginTop: 4,
  },
  drillCounter: {
    color: '#2076d2',
    fontSize: 15,
    fontWeight: '800',
  },
  cueScroller: {
    marginBottom: 14,
  },
  cuePill: {
    backgroundColor: '#e3eef7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
  },
  cueText: {
    color: '#26313b',
    fontSize: 13,
    fontWeight: '700',
  },
  metadata: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
  },
  metadataText: {
    color: '#39434d',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 3,
  },
  bv100Panel: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
  },
  bv100Header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  bv100Title: {
    color: '#151a1f',
    fontSize: 18,
    fontWeight: '900',
  },
  bv100Status: {
    color: '#59636e',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  statusPill: {
    borderRadius: 8,
    backgroundColor: '#edf1f5',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusPillActive: {
    backgroundColor: '#dff5e9',
  },
  statusPillText: {
    color: '#59636e',
    fontSize: 12,
    fontWeight: '900',
  },
  statusPillTextActive: {
    color: '#207a4a',
  },
  sasInput: {
    minHeight: 42,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bcc6d0',
    color: '#151a1f',
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 10,
    marginBottom: 10,
  },
  bv100ButtonRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  bv100Button: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bcc6d0',
    paddingVertical: 11,
    alignItems: 'center',
  },
  bv100ButtonActive: {
    backgroundColor: '#2076d2',
    borderColor: '#2076d2',
  },
  bv100ButtonText: {
    color: '#26313b',
    fontSize: 12,
    fontWeight: '900',
  },
  bv100ButtonTextActive: {
    color: '#ffffff',
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  primaryButton: {
    backgroundColor: '#2076d2',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bcc6d0',
    paddingVertical: 13,
    alignItems: 'center',
  },
  sessionButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bcc6d0',
    marginTop: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  detailsButton: {
    borderRadius: 8,
    backgroundColor: '#151a1f',
    marginTop: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  detailsButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
  },
  secondaryButtonText: {
    color: '#26313b',
    fontSize: 14,
    fontWeight: '800',
  },
  recordButton: {
    flex: 1.7,
    backgroundColor: '#2076d2',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  stopButton: {
    backgroundColor: '#d83a3a',
  },
  recordButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  savedText: {
    color: '#2b8558',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 12,
    textAlign: 'center',
  },
  detailsScreen: {
    flex: 1,
    backgroundColor: '#f5f7f9',
  },
  detailsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#dde4eb',
  },
  detailsHeaderCopy: {
    flex: 1,
    paddingRight: 12,
  },
  detailsKicker: {
    color: '#2076d2',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  detailsTitle: {
    color: '#151a1f',
    fontSize: 24,
    fontWeight: '900',
    marginTop: 2,
  },
  closeButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bcc6d0',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  closeButtonText: {
    color: '#26313b',
    fontSize: 13,
    fontWeight: '900',
  },
  detailsContent: {
    padding: 18,
    paddingBottom: 28,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 14,
  },
  summaryCard: {
    width: '47%',
    minHeight: 86,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    padding: 12,
    justifyContent: 'space-between',
  },
  summaryLabel: {
    color: '#59636e',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  summaryValue: {
    color: '#151a1f',
    fontSize: 25,
    fontWeight: '900',
    marginTop: 8,
  },
  detailSection: {
    borderRadius: 8,
    backgroundColor: '#ffffff',
    padding: 14,
    marginBottom: 12,
  },
  detailSectionTitle: {
    color: '#151a1f',
    fontSize: 17,
    fontWeight: '900',
    marginBottom: 8,
  },
  detailLine: {
    color: '#39434d',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 19,
    marginBottom: 4,
  },
  clipRow: {
    borderTopWidth: 1,
    borderTopColor: '#edf1f5',
    paddingTop: 10,
    marginTop: 8,
  },
  clipTitle: {
    color: '#151a1f',
    fontSize: 14,
    fontWeight: '900',
    marginBottom: 4,
  },
});
