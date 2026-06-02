import { CameraView, useCameraPermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import { StatusBar } from 'expo-status-bar';
import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type Drill = {
  id: string;
  label: string;
  title: string;
  target: string;
  cues: string[];
};

const DRILLS: Drill[] = [
  {
    id: 'perfect_curl',
    label: 'good_form',
    title: 'Curl perfecto',
    target: '10-12 reps limpias',
    cues: ['Torso quieto', 'Hombro estable', 'Rango completo', 'Tempo controlado'],
  },
  {
    id: 'torso_swing',
    label: 'torso_swing',
    title: 'Curl ladeado',
    target: '8-10 reps con torso swing',
    cues: ['Balancea el torso un poco', 'Mantén el brazo visible', 'No exageres el movimiento'],
  },
  {
    id: 'shoulder_move',
    label: 'shoulder_move',
    title: 'Hombro adelante',
    target: '8-10 reps moviendo hombro',
    cues: ['Lleva el codo adelante', 'No uses demasiado torso', 'Mantén muñeca visible'],
  },
  {
    id: 'partial_rep',
    label: 'partial_rep',
    title: 'Rep parcial',
    target: '8-12 reps incompletas',
    cues: ['Sube a mitad', 'Vuelve a extender', 'No completes el curl'],
  },
  {
    id: 'fatigue',
    label: 'fatigue',
    title: 'Fatiga real',
    target: 'Serie hasta esfuerzo alto',
    cues: ['Empieza limpio', 'Sigue hasta cansarte', 'Para si hay dolor'],
  },
];

export default function App() {
  const cameraRef = useRef<CameraView>(null);
  const recordingPromise = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  const [savedClips, setSavedClips] = useState(0);
  const [lastClipUri, setLastClipUri] = useState('');

  const selectedDrill = DRILLS[selectedIndex];
  const sessionId = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `${selectedDrill.id}_${today}`;
  }, [selectedDrill.id]);

  const hasCameraPermission = cameraPermission?.granted;
  const hasMediaPermission = mediaPermission?.granted;

  async function requestPermissions() {
    await requestCameraPermission();
    await requestMediaPermission();
  }

  async function startRecording() {
    if (!cameraRef.current || recording) {
      return;
    }
    if (!hasMediaPermission) {
      await requestMediaPermission();
    }

    setRecording(true);
    recordingPromise.current = cameraRef.current.recordAsync({
      maxDuration: 120,
    });

    recordingPromise.current
      .then(async (video) => {
        if (!video?.uri) {
          return;
        }
        const asset = await MediaLibrary.createAssetAsync(video.uri);
        await MediaLibrary.createAlbumAsync('Curl Vision Foundry', asset, false);
        setSavedClips((count) => count + 1);
        setLastClipUri(video.uri);
      })
      .catch((error) => {
        Alert.alert('Recording failed', String(error));
      })
      .finally(() => {
        setRecording(false);
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

  if (!hasCameraPermission || !hasMediaPermission) {
    return (
      <SafeAreaView style={styles.permissionScreen}>
        <StatusBar style="light" />
        <Text style={styles.appTitle}>Curl Vision Foundry</Text>
        <Text style={styles.permissionTitle}>Permisos necesarios</Text>
        <Text style={styles.permissionText}>
          La app necesita cámara frontal y permiso para guardar videos en Fotos. Los clips quedan en
          tu iPhone para entrenar tu coach personal después.
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
            <Text style={styles.overlayLabel}>Training capture</Text>
            <Text style={styles.overlayTitle}>{selectedDrill.title}</Text>
          </View>
          <View style={[styles.recordingDot, recording && styles.recordingDotActive]} />
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.progressRow}>
          {DRILLS.map((drill, index) => (
            <Pressable
              key={drill.id}
              style={[styles.stepDot, index === selectedIndex && styles.stepDotActive]}
              onPress={() => setSelectedIndex(index)}
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
          <Text style={styles.metadataText}>label: {selectedDrill.label}</Text>
          <Text style={styles.metadataText}>clips saved: {savedClips}</Text>
        </View>

        <View style={styles.buttonRow}>
          <Pressable style={styles.secondaryButton} onPress={previousDrill} disabled={recording}>
            <Text style={styles.secondaryButtonText}>Anterior</Text>
          </Pressable>
          <Pressable
            style={[styles.recordButton, recording && styles.stopButton]}
            onPress={recording ? stopRecording : startRecording}
          >
            <Text style={styles.recordButtonText}>{recording ? 'Detener' : 'Grabar prueba'}</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={nextDrill} disabled={recording}>
            <Text style={styles.secondaryButtonText}>Siguiente</Text>
          </Pressable>
        </View>

        {lastClipUri ? <Text style={styles.savedText}>Ultimo clip guardado en Fotos</Text> : null}
      </View>
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
});
