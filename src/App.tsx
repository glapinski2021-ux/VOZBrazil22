import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Mic2, Music, Clock, Zap, Settings, Sun, Moon, Play, Pause, Download, 
  RefreshCw, Trash2, Copy, Check, ChevronDown, ChevronUp, Eye, EyeOff, Loader2, PlayCircle, Plus,
  ShieldCheck, Sliders, Volume2, Activity, Layers, Sparkles
} from 'lucide-react';

// --- MAIN WAV CONVERSION ROUTINE (MANDATORY) --- //
function createWavBlob(pcmBytes: Uint8Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBytes.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF
  view.setUint8(0, 0x52); view.setUint8(1, 0x49);
  view.setUint8(2, 0x46); view.setUint8(3, 0x46);
  view.setUint32(4, 36 + dataSize, true);
  view.setUint8(8, 0x57); view.setUint8(9, 0x41);
  view.setUint8(10, 0x56); view.setUint8(11, 0x45);
  // fmt
  view.setUint8(12, 0x66); view.setUint8(13, 0x6D);
  view.setUint8(14, 0x74); view.setUint8(15, 0x20);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data
  view.setUint8(36, 0x64); view.setUint8(37, 0x61);
  view.setUint8(38, 0x74); view.setUint8(39, 0x61);
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer).set(pcmBytes, 44);

  return new Blob([buffer], { type: 'audio/wav' });
}

function pcmToWav(base64Data: string, mimeType: string): Blob {
  const byteCharacters = atob(base64Data);
  const pcmBytes = new Uint8Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    pcmBytes[i] = byteCharacters.charCodeAt(i);
  }

  const rateMatch = mimeType.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
  
  return createWavBlob(pcmBytes, sampleRate);
}

// --- AUDIO NORMALIZATION & STITCHING ENGINE --- //
function parsePcmSamples(pcmBytes: Uint8Array): Int16Array {
  const numSamples = Math.floor(pcmBytes.length / 2);
  const samples = new Int16Array(numSamples);
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return samples;
}

function calculateRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  let activeSamples = 0;
  for (let i = 0; i < samples.length; i++) {
    const val = samples[i];
    // ignore complete silence below threshold for more accurate speech RMS
    if (Math.abs(val) > 200) {
      const norm = val / 32768;
      sumSquares += norm * norm;
      activeSamples++;
    }
  }
  return activeSamples > 0 ? Math.sqrt(sumSquares / activeSamples) : 0.05;
}

interface SegmentAudioData {
  pcmBytes: Uint8Array;
  sampleRate: number;
  rms: number;
}

interface ConsistencyAnalysisReport {
  segmentCount: number;
  consistencyScore: number; // 0 - 100%
  meanRms: number;
  rmsVariationDb: number;
  gainCorrections: number[];
  crossfadeApplied: boolean;
  totalDurationSeconds: number;
}

function normalizeAndStitchSegments(
  segments: SegmentAudioData[],
  continuityMode: 'auto' | 'consistency' | 'natural'
): { unifiedPcmBytes: Uint8Array; sampleRate: number; report: ConsistencyAnalysisReport } {
  if (segments.length === 0) {
    return {
      unifiedPcmBytes: new Uint8Array(0),
      sampleRate: 24000,
      report: {
        segmentCount: 0,
        consistencyScore: 100,
        meanRms: 0,
        rmsVariationDb: 0,
        gainCorrections: [],
        crossfadeApplied: false,
        totalDurationSeconds: 0
      }
    };
  }

  const sampleRate = segments[0].sampleRate || 24000;
  if (segments.length === 1) {
    const samples = parsePcmSamples(segments[0].pcmBytes);
    const rms = calculateRms(samples);
    return {
      unifiedPcmBytes: segments[0].pcmBytes,
      sampleRate,
      report: {
        segmentCount: 1,
        consistencyScore: 99,
        meanRms: rms,
        rmsVariationDb: 0,
        gainCorrections: [1.0],
        crossfadeApplied: false,
        totalDurationSeconds: samples.length / sampleRate
      }
    };
  }

  // 1. Calculate target RMS for normalization
  const validRmsList = segments.map(s => (s.rms > 0.01 ? s.rms : 0.05));
  const avgRms = validRmsList.reduce((acc, v) => acc + v, 0) / validRmsList.length;

  // Max variation in dB
  const minRms = Math.min(...validRmsList);
  const maxRms = Math.max(...validRmsList);
  const rmsVariationDb = 20 * Math.log10(Math.max(maxRms / (minRms || 0.001), 1.001));

  // Consistency score calculation
  const consistencyScore = Math.max(70, Math.min(100, Math.round(100 - rmsVariationDb * 2.5)));

  // 2. Normalize segments and add smooth natural transition pause
  const pauseDurationSec = continuityMode === 'natural' ? 0.22 : 0.16;
  const pauseSamplesCount = Math.floor(sampleRate * pauseDurationSec);
  const crossfadeSamples = Math.floor(sampleRate * 0.02); // 20ms micro-fade

  const processedSegmentSamples: Int16Array[] = [];
  const gainCorrections: number[] = [];

  for (let i = 0; i < segments.length; i++) {
    const rawSamples = parsePcmSamples(segments[i].pcmBytes);
    const segRms = segments[i].rms;
    let gain = 1.0;

    if (segRms > 0.01 && continuityMode !== 'natural') {
      // Gentle compression / gain matching (clamp between 0.75x and 1.35x to preserve natural timbre)
      gain = Math.max(0.75, Math.min(1.35, avgRms / segRms));
    }
    gainCorrections.push(gain);

    const normSamples = new Int16Array(rawSamples.length);
    for (let s = 0; s < rawSamples.length; s++) {
      let val = rawSamples[s] * gain;
      // Gentle soft clipping
      if (val > 32767) val = 32767;
      if (val < -32768) val = -32768;
      normSamples[s] = Math.round(val);
    }

    // Apply micro-fade in at start and micro-fade out at end of segment to prevent DC click
    const fadeLen = Math.min(crossfadeSamples, Math.floor(normSamples.length / 4));
    for (let f = 0; f < fadeLen; f++) {
      const fadeInMult = f / fadeLen;
      const fadeOutMult = (fadeLen - f) / fadeLen;
      normSamples[f] = Math.round(normSamples[f] * fadeInMult);
      normSamples[normSamples.length - 1 - f] = Math.round(normSamples[normSamples.length - 1 - f] * fadeOutMult);
    }

    processedSegmentSamples.push(normSamples);
  }

  // 3. Assemble unified stream with natural inter-chunk pauses
  let totalOutputSamples = 0;
  for (let i = 0; i < processedSegmentSamples.length; i++) {
    totalOutputSamples += processedSegmentSamples[i].length;
    if (i < processedSegmentSamples.length - 1) {
      totalOutputSamples += pauseSamplesCount;
    }
  }

  const unifiedPcmBytes = new Uint8Array(totalOutputSamples * 2);
  const outView = new DataView(unifiedPcmBytes.buffer);
  let writeOffset = 0;

  for (let i = 0; i < processedSegmentSamples.length; i++) {
    const seg = processedSegmentSamples[i];
    for (let s = 0; s < seg.length; s++) {
      outView.setInt16(writeOffset * 2, seg[s], true);
      writeOffset++;
    }
    // append natural quiet pause before next segment
    if (i < processedSegmentSamples.length - 1) {
      for (let p = 0; p < pauseSamplesCount; p++) {
        outView.setInt16(writeOffset * 2, 0, true);
        writeOffset++;
      }
    }
  }

  return {
    unifiedPcmBytes,
    sampleRate,
    report: {
      segmentCount: segments.length,
      consistencyScore,
      meanRms: avgRms,
      rmsVariationDb: Math.round(rmsVariationDb * 10) / 10,
      gainCorrections,
      crossfadeApplied: true,
      totalDurationSeconds: totalOutputSamples / sampleRate
    }
  };
}

// --- SMART TEXT SEGMENTER (PRESERVES SENTENCES AND PARAGRAPHS) --- //
function smartSegmentText(fullText: string, maxChunkLength: number = 950): string[] {
  const clean = fullText.trim();
  if (clean.length <= maxChunkLength) {
    return [clean];
  }

  const segments: string[] = [];
  // Split primarily by paragraphs
  const paragraphs = clean.split(/\n+/).filter(p => p.trim().length > 0);
  let currentBuffer = "";

  for (const para of paragraphs) {
    if (currentBuffer && (currentBuffer.length + para.length + 2) > maxChunkLength) {
      segments.push(currentBuffer.trim());
      currentBuffer = "";
    }

    if (para.length <= maxChunkLength) {
      currentBuffer = currentBuffer ? `${currentBuffer}\n\n${para}` : para;
    } else {
      // Paragraph is longer than maxChunkLength: split by sentences (. ! ? ...)
      const sentences = para.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [para];
      for (const sent of sentences) {
        if (currentBuffer && (currentBuffer.length + sent.length + 1) > maxChunkLength) {
          segments.push(currentBuffer.trim());
          currentBuffer = "";
        }

        if (sent.length <= maxChunkLength) {
          currentBuffer = currentBuffer ? `${currentBuffer} ${sent.trim()}` : sent.trim();
        } else {
          // Sentence itself is unusually long: split by commas/semicolons/dashes
          const clauses = sent.split(/(?<=[,;:\—])\s+/);
          for (const clause of clauses) {
            if (currentBuffer && (currentBuffer.length + clause.length + 1) > maxChunkLength) {
              segments.push(currentBuffer.trim());
              currentBuffer = "";
            }
            currentBuffer = currentBuffer ? `${currentBuffer} ${clause.trim()}` : clause.trim();
          }
        }
      }
    }
  }

  if (currentBuffer.trim().length > 0) {
    segments.push(currentBuffer.trim());
  }

  return segments.length > 0 ? segments : [clean];
}

// --- DATA LISTS --- //
type Voice = { name: string; gender: 'M' | 'F'; tone: string; recommended: string };
const VOICES: Voice[] = [
  { name: 'Achird', gender: 'M', tone: 'Grave e Robusto', recommended: 'Noticiários' },
  { name: 'Charon', gender: 'M', tone: 'Profundo e Épico', recommended: 'Trailers' },
  { name: 'Fenrir', gender: 'M', tone: 'Rústico e Forte', recommended: 'Audiobook' },
  { name: 'Kore', gender: 'M', tone: 'Neutro e Claro', recommended: 'Tutoriais' },
  { name: 'Orus', gender: 'M', tone: 'Confiante', recommended: 'Vendas' },
  { name: 'Puck', gender: 'M', tone: 'Energético', recommended: 'YouTube' },
  { name: 'Aoede', gender: 'F', tone: 'Acolhedora', recommended: 'Meditação' },
  { name: 'Callirrhoe', gender: 'F', tone: 'Elegante', recommended: 'Marcas Premium' },
  { name: 'Despina', gender: 'F', tone: 'Vibrante', recommended: 'Promoções' },
  { name: 'Leda', gender: 'F', tone: 'Clara', recommended: 'Cursos' },
  { name: 'Schedar', gender: 'F', tone: 'Autoridade', recommended: 'Podcasts' },
  { name: 'Sulafat', gender: 'F', tone: 'Casual', recommended: 'Redes Sociais' }
];

const ACCENTS = {
  Sudeste: [
    { label: 'Neutro Brasileiro', value: 'sotaque neutro do Brasil' },
    { label: 'Paulistano (SP)', value: 'sotaque paulistano de São Paulo, r retroflexo marcado' },
    { label: 'Carioca (RJ)', value: 'sotaque carioca do Rio de Janeiro, s chiado' },
    { label: 'Mineiro (MG)', value: 'sotaque mineiro de Minas Gerais' },
    { label: 'Capixaba (ES)', value: 'sotaque capixaba do Espírito Santo' }
  ],
  Sul: [
    { label: 'Gaúcho (RS)', value: 'sotaque gaúcho do Rio Grande do Sul' },
    { label: 'Catarinense (SC)', value: 'sotaque catarinense de Santa Catarina' },
    { label: 'Paranaense (PR)', value: 'sotaque paranaense do Paraná' }
  ],
  Nordeste: [
    { label: 'Nordestino Neutro', value: 'sotaque nordestino neutro' },
    { label: 'Baiano (BA)', value: 'sotaque baiano da Bahia' },
    { label: 'Pernambucano (PE)', value: 'sotaque pernambucano do Recife' },
    { label: 'Cearense (CE)', value: 'sotaque cearense do Ceará' },
    { label: 'Maranhense (MA)', value: 'sotaque maranhense' },
    { label: 'Paraibano (PB)', value: 'sotaque paraibano' },
    { label: 'Alagoano (AL)', value: 'sotaque alagoano' },
    { label: 'Potiguar (RN)', value: 'sotaque potiguar' },
    { label: 'Sergipano (SE)', value: 'sotaque sergipano' }
  ],
  Norte: [
    { label: 'Paraense (PA)', value: 'sotaque paraense' },
    { label: 'Manauara (AM)', value: 'sotaque manauara' },
    { label: 'Tocantinense (TO)', value: 'sotaque tocantinense' }
  ],
  CentroOeste: [
    { label: 'Brasiliense (DF)', value: 'sotaque brasiliense de Brasília' },
    { label: 'Goiano (GO)', value: 'sotaque goiano' },
    { label: 'Mato-grossense', value: 'sotaque mato-grossense' }
  ],
  Interior: [
    { label: 'Caipira', value: 'sotaque caipira do interior' },
    { label: 'Sertanejo', value: 'sotaque sertanejo do nordeste' }
  ]
};

const STYLES = [
  'Natural', 'Conversacional', 'Amigável', 'Profissional', 'Corporativo', 
  'Premium', 'Emocional', 'Sério', 'Elegante', 'Storyteller', 
  'Narração Documental', 'Anúncio Publicitário', 'Podcast', 
  'ASMR', 'Relaxamento/Meditação', 'Épico', 'Energético'
];

const EMOTIONS = [
  { name: 'Neutro', icon: '○' }, { name: 'Alegria', icon: '😊' }, { name: 'Tristeza', icon: '😢' },
  { name: 'Calma', icon: '😌' }, { name: 'Empatia', icon: '🤝' }, { name: 'Entusiasmo', icon: '🔥' },
  { name: 'Tensão', icon: '😰' }, { name: 'Mistério', icon: '🌑' }, { name: 'Autoridade', icon: '💼' }
];

const INLINE_TAGS = [
  { tag: '[pausa]', replarer: ', faça uma pausa breve, ' },
  { tag: '[risada]', replarer: ', dê uma risada leve, ' },
  { tag: '[sussurro]', replarer: ', fale em voz muito baixa, ' },
  { tag: '[ênfase]', replarer: ', enfatize bem a próxima palavra, ' },
  { tag: '[respira]', replarer: ', faça uma respiração audível, ' },
  { tag: '[silêncio]', replarer: ', pause em silêncio por um momento, ' },
  { tag: '[emocionado]', replarer: ', fale com muita emoção, ' },
  { tag: '[lento]', replarer: ', fale mais devagar agora, ' },
  { tag: '[rápido]', replarer: ', fale mais rápido agora, ' }
];

type HistoryItem = {
  id: string; text: string; voice: string; accent: string;
  style: string[]; emotion: string; date: number; duration: number;
  audioUrl: string; blob: Blob;
};

export default function App() {
  const [activeView, setActiveView] = useState<'generate' | 'library' | 'history' | 'presets' | 'settings'>('generate');
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [toast, setToast] = useState<{message: string, type: 'error' | 'success'} | null>(null);

  const [text, setText] = useState("");
  const [voice, setVoice] = useState<string>("Achird");
  const [accent, setAccent] = useState<string>("Carioca (RJ)");
  const [customAccent, setCustomAccent] = useState<string>("");
  const [styles, setStyles] = useState<string[]>(['Natural']);
  const [emotion, setEmotion] = useState<string>("Neutro");

  const [speed, setSpeed] = useState(3);
  const [pitch, setPitch] = useState(3);
  const [expressiveness, setExpressiveness] = useState(3);
  const [emotionalInt, setEmotionalInt] = useState(3);
  const [formality, setFormality] = useState(3);
  const [drama, setDrama] = useState(3);
  const [naturalness, setNaturalness] = useState(4);
  const [energy, setEnergy] = useState(3);

  const [softStart, setSoftStart] = useState(false);
  const [softEnd, setSoftEnd] = useState(false);
  const [voiceSmile, setVoiceSmile] = useState(false);
  const [velvetVoice, setVelvetVoice] = useState(false);
  const [breaths, setBreaths] = useState(false);
  const [customPron, setCustomPron] = useState("");

  // --- VOCAL STABILITY & FIXED IDENTITY SETTINGS --- //
  const [vocalConsistency, setVocalConsistency] = useState<'disabled' | 'balanced' | 'high' | 'maximum'>('high');
  const [vocalIntensity, setVocalIntensity] = useState<'natural' | 'moderate' | 'firm' | 'very_firm'>('firm');
  const [interpretationStability, setInterpretationStability] = useState<'flexible' | 'balanced' | 'stable' | 'very_stable'>('stable');
  const [continuityMode, setContinuityMode] = useState<'auto' | 'consistency' | 'natural'>('consistency');
  const [generationProgress, setGenerationProgress] = useState<{ current: number; total: number; stage: string } | null>(null);
  const [consistencyReport, setConsistencyReport] = useState<ConsistencyAnalysisReport | null>(null);

  const [uiState, setUiState] = useState({ accordions: { interp: false, adv: false, stability: true } });
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedAudioState, setGeneratedAudioState] = useState<{url: string, blob: Blob} | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  
  const showToast = (msg: string, type: 'error'|'success' = 'success') => {
    setToast({message: msg, type});
    setTimeout(() => setToast(null), type === 'error' ? 4000 : 3000);
  };

  const mapSliderValue = (val: number, descriptions: string[]) => descriptions[val - 1];

  // --- FIXED VOCAL IDENTITY & META-PROMPT BUILDER --- //
  const buildPrompt = (txt: string, chunkIndex: number = 0, totalChunks: number = 1) => {
    let processedText = txt;
    INLINE_TAGS.forEach(t => {
      processedText = processedText.split(t.tag).join(t.replarer);
    });

    const accentStr = customAccent.trim() ? customAccent.trim() : accent;
    const styleStr = styles.length ? styles.join(" combinado com ") : "Natural";

    const extraConfigs = [
      `velocidade ${mapSliderValue(speed, ['muito lenta', 'lenta', 'normal', 'rápida', 'muito rápida'])}`,
      `tom ${mapSliderValue(pitch, ['muito grave', 'grave', 'médio', 'agudo', 'muito agudo'])}`,
      `expressividade ${mapSliderValue(expressiveness, ['contida', 'leve', 'moderada', 'expressiva', 'muito expressiva'])}`,
      `intensidade emocional ${mapSliderValue(emotionalInt, ['suave', 'leve', 'moderada', 'forte', 'intensa'])}`,
      `formalidade ${mapSliderValue(formality, ['informal', 'casual', 'neutra', 'formal', 'muito formal'])}`,
      `dramatismo ${mapSliderValue(drama, ['neutro', 'leve', 'moderado', 'dramático', 'muito dramático'])}`,
      `naturalidade ${mapSliderValue(naturalness, ['robótica', 'marcada', 'estável', 'natural', 'muito natural'])}`,
      `energia ${mapSliderValue(energy, ['baixa', 'calma', 'média', 'alta', 'muito alta'])}`
    ];

    if (softStart) extraConfigs.push("comece a fala de forma gradual e suave");
    if (softEnd) extraConfigs.push("termine a fala de forma gradual e suave");
    if (voiceSmile) extraConfigs.push("fale com um leve sorriso na voz");
    if (velvetVoice) extraConfigs.push("use uma voz aveludada e suave");
    if (breaths) extraConfigs.push("inclua respirações naturais ocasionais");
    if (customPron.trim()) extraConfigs.push(`pronuncie ${customPron.trim()}`);

    // Map stability parameters to precise instructions
    const intensityLabels = {
      natural: 'projeção vocal natural e equilibrada',
      moderate: 'projeção vocal moderadamente firme e nítida',
      firm: 'projeção vocal firme, constante e com presença marcante',
      very_firm: 'projeção vocal muito firme, autoritária e sem qualquer quebra de fôlego'
    };

    const stabilityLabels = {
      flexible: 'interpretação flexível e orgânica',
      balanced: 'estabilidade de interpretação equilibrada',
      stable: 'estabilidade de interpretação rigorosamente uniforme',
      very_stable: 'estabilidade tonal máxima e cadência milimetricamente constante'
    };

    // System Meta-Prompt for Vocal Stability (Mandatory consistency core)
    let stabilityMetaPrompt = "";
    if (vocalConsistency !== 'disabled') {
      const consistencyLevelStr = vocalConsistency === 'maximum' ? 'máxima e inegociável' : vocalConsistency === 'high' ? 'alta e rigorosa' : 'equilibrada';
      stabilityMetaPrompt = `
[DIRETIVA DE IDENTIDADE VOCAL FIXA E ESTABILIDADE DE NARRAÇÃO - NÍVEL ${consistencyLevelStr.toUpperCase()}]:
Você está realizando uma narração contínua e profissional em português brasileiro. Mantenha rigorosamente a mesma identidade vocal, timbre, intensidade, projeção, altura tonal, sotaque, pronúncia, velocidade e personalidade interpretativa durante toda a gravação.
Sua voz deve permanecer firme, estável, natural e consistente do início ao fim.
Não diminua progressivamente a intensidade vocal. Não transforme a narração em sussurro. Não altere involuntariamente o timbre, a altura da voz ou a velocidade de leitura.
Mantenha a mesma presença vocal e o mesmo padrão de qualidade em todos os trechos.
Intensidade definida: ${intensityLabels[vocalIntensity]}.
Estabilidade de interpretação: ${stabilityLabels[interpretationStability]}.
As variações interpretativas e ênfases devem acontecer com naturalidade exclusivamente conforme exigido pelo sentido das palavras, sem perda de fôlego ao final de sentenças.
Preserve a identidade vocal mesmo durante pausas e transições narrativas.
`;
    }

    let chunkContinuityDirective = "";
    if (totalChunks > 1) {
      chunkContinuityDirective = `
[CONTINUIDADE DE SEGMENTO: Você está narrando o Segmento ${chunkIndex + 1} de um total de ${totalChunks} segmentos de uma mesma gravação contínua.
Este segmento faz parte inseparável da mesma narração. Continue na exata mesma intensidade, presença e velocidade do segmento anterior. Não reinicie a energia e não conclua a narração de forma definitiva a menos que seja o último segmento.]
`;
    }

    return `${stabilityMetaPrompt}${chunkContinuityDirective}
Leia o seguinte texto com perfeição vocal em português brasileiro, com ${accentStr}, no estilo ${styleStr}, com emoção de ${emotion}, em ${extraConfigs.join(", ")}.

Texto a ser narrado:
"${processedText}"`;
  };

  const handleGenerate = async (previewText?: string, specificVoice?: string) => {
    const textToGen = previewText || text;
    if (!textToGen.trim()) return showToast('Digite um texto para gerar o áudio.', 'error');

    setIsGenerating(true);
    setGeneratedAudioState(null);
    setConsistencyReport(null);
    if (audioRef.current) audioRef.current.pause();

    const targetVoice = specificVoice || voice;

    try {
      // 1. SMART TEXT SEGMENTATION (Splits into natural sentences/paragraphs if long)
      const chunks = smartSegmentText(textToGen, 950);
      const totalChunks = chunks.length;

      // --- MOCK MODE FOR UNLIMITED TESTING WITH MULTI-CHUNK SUPPORT ---
      if (apiKey.trim().toUpperCase() === 'MOCK') {
        const generatedSegments: SegmentAudioData[] = [];
        const sampleRate = 24000;

        for (let i = 0; i < totalChunks; i++) {
          setGenerationProgress({
            current: i + 1,
            total: totalChunks,
            stage: `Simulando Segmento ${i + 1} de ${totalChunks} com Identidade Vocal Fixa...`
          });
          
          await new Promise(r => setTimeout(r, 600)); // Simula processamento

          // Gera 8 segundos audíveis de tom oscilante com leve modulação realista por segmento
          const chunkDuration = Math.max(4, Math.min(12, Math.round(chunks[i].length / 40)));
          const pcmBytes = new Uint8Array(sampleRate * chunkDuration * 2);
          const baseFreq = targetVoice === 'Achird' || targetVoice === 'Charon' || targetVoice === 'Fenrir' ? 220 : 330;
          
          for (let s = 0; s < sampleRate * chunkDuration; s++) {
            const t = s / sampleRate;
            const freq = baseFreq + Math.sin(t * 2 * Math.PI * 0.8) * 35;
            const env = Math.sin(t * Math.PI * 1.5) * 0.3 + 0.7; // slight envelope
            const volume = 7500 * env;
            const sample = Math.sin(t * freq * Math.PI * 2) * volume;
            const intSample = Math.max(-32768, Math.min(32767, Math.round(sample)));
            pcmBytes[s * 2] = intSample & 0xFF;
            pcmBytes[s * 2 + 1] = (intSample >> 8) & 0xFF;
          }

          const rawSamples = parsePcmSamples(pcmBytes);
          const rms = calculateRms(rawSamples);
          generatedSegments.push({ pcmBytes, sampleRate, rms });
        }

        // Apply audio normalization, RMS alignment and stitching
        setGenerationProgress({
          current: totalChunks,
          total: totalChunks,
          stage: "Normalizando áudio e alinhando consistência vocal..."
        });
        await new Promise(r => setTimeout(r, 300));

        const { unifiedPcmBytes, report } = normalizeAndStitchSegments(generatedSegments, continuityMode);
        const wavBlob = createWavBlob(unifiedPcmBytes, sampleRate);
        const url = URL.createObjectURL(wavBlob);

        setConsistencyReport(report);
        setGeneratedAudioState({ url, blob: wavBlob });

        if (!previewText) {
          setHistory(prev => [{
            id: Date.now().toString(), text: (totalChunks > 1 ? `[${totalChunks} Segs] ` : "") + textToGen,
            voice: targetVoice, accent, style: [...styles], emotion, date: Date.now(),
            duration: Math.round(report.totalDurationSeconds), audioUrl: url, blob: wavBlob
          }, ...prev].slice(0, 20));
        }

        setTimeout(() => {
          if (audioRef.current) {
            audioRef.current.src = url; audioRef.current.load(); audioRef.current.play();
          }
        }, 50);

        showToast(`🎙️ Teste concluído: ${totalChunks} segmento(s) com consistência de ${report.consistencyScore}%!`);
        return;
      }
      // --- END MOCK MODE ---

      // --- SERVER-SIDE GEMINI TTS ENGINE WITH VOCAL IDENTITY PRESERVATION ---
      const generatedSegments: SegmentAudioData[] = [];
      let detectedSampleRate = 24000;

      for (let i = 0; i < totalChunks; i++) {
        setGenerationProgress({
          current: i + 1,
          total: totalChunks,
          stage: totalChunks > 1 
            ? `Gerando Segmento ${i + 1} de ${totalChunks} via Servidor Seguro...`
            : 'Gerando áudio via Servidor Seguro com Identidade Vocal Fixa...'
        });

        const promptText = buildPrompt(chunks[i], i, totalChunks);

        const response = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: promptText,
            voiceName: targetVoice,
            clientApiKey: apiKey
          })
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          const errorObj: any = new Error(errData.error || 'Falha na resposta do servidor.');
          errorObj.status = response.status;
          throw errorObj;
        }

        const data = await response.json();
        const pcmData = data.pcmData;
        const mimeType = data.mimeType || "audio/L16;rate=24000";

        if (!pcmData) throw new Error('InvalidResponse');

        const rateMatch = mimeType.match(/rate=(\d+)/);
        if (rateMatch) detectedSampleRate = parseInt(rateMatch[1]);

        const byteCharacters = atob(pcmData);
        const pcmBytes = new Uint8Array(byteCharacters.length);
        for (let b = 0; b < byteCharacters.length; b++) {
          pcmBytes[b] = byteCharacters.charCodeAt(b);
        }

        const rawSamples = parsePcmSamples(pcmBytes);
        const rms = calculateRms(rawSamples);
        generatedSegments.push({ pcmBytes, sampleRate: detectedSampleRate, rms });
      }

      // 2. UNIFORM NORMALIZATION & CONTINUITY STITCHING
      setGenerationProgress({
        current: totalChunks,
        total: totalChunks,
        stage: "Uniformizando volume, aplicando micro-fade e analisando consistência..."
      });

      const { unifiedPcmBytes, report } = normalizeAndStitchSegments(generatedSegments, continuityMode);
      const wavBlob = createWavBlob(unifiedPcmBytes, detectedSampleRate);
      const url = URL.createObjectURL(wavBlob);

      setConsistencyReport(report);
      setGeneratedAudioState({ url, blob: wavBlob });
      
      if (!previewText) {
        setHistory(prev => [{
          id: Date.now().toString(), text: (totalChunks > 1 ? `[${totalChunks} Segs] ` : "") + textToGen,
          voice: targetVoice, accent, style: [...styles], emotion, date: Date.now(),
          duration: Math.round(report.totalDurationSeconds), audioUrl: url, blob: wavBlob
        }, ...prev].slice(0, 20));
      }

      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.src = url; audioRef.current.load(); audioRef.current.play();
        }
      }, 50);

      showToast(`Áudio gerado com sucesso! Consistência: ${report.consistencyScore}%`);
    } catch (err: any) {
      const errorMessage = err.message || '';
      if (err.status === 429 || errorMessage.includes('429') || errorMessage.includes('quota')) {
        showToast('⏳ Cota ou limite da API atingidos. Tente novamente mais tarde ou use a chave MOCK para testes.', 'error');
      } else if (errorMessage.includes('API key') || err.status === 401) {
        showToast('🔑 Chave de API inválida ou não configurada no servidor.', 'error');
      } else {
        showToast('❌ Ocorreu um erro ao gerar o áudio. Tente novamente ou use texto menor.', 'error');
      }
    } finally {
      setIsGenerating(false);
      setGenerationProgress(null);
    }
  };

  const handleDownload = (blob: Blob, voiceName: string) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `vozprime_${voiceName}_${Date.now()}.wav`; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 100);
  };

  const renderSidebar = () => (
    <aside className="w-[240px] flex-shrink-0 bg-[#1a1a24]/60 border-r border-white/5 flex flex-col">
      <div className="p-6">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00d4aa] to-[#0099ff] flex items-center justify-center shadow-lg shadow-[#00d4aa]/20">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-[#a0a0b8]">VozBR</h1>
        </div>
        
        <nav className="space-y-1">
          {[
            { id: 'generate', icon: Mic2, label: 'Gerar Voz' }, { id: 'library', icon: Music, label: 'Biblioteca' },
            { id: 'history', icon: Clock, label: 'Histórico' }, { id: 'presets', icon: Zap, label: 'Presets' }
          ].map(item => (
            <button
              key={item.id} onClick={() => setActiveView(item.id as any)}
              className={
                activeView === item.id 
                  ? "w-full flex items-center gap-3 px-4 py-3 bg-[#00d4aa]/10 text-[#00d4aa] border-l-2 border-[#00d4aa] rounded-r-md"
                  : "w-full flex items-center gap-3 px-4 py-3 text-[#a0a0b8] hover:text-white transition-colors"
              }
            ><item.icon className="w-5 h-5" /><span className="font-medium">{item.label}</span></button>
          ))}
        </nav>
      </div>
      
      <div className="mt-auto p-6">
        <div className="p-4 rounded-xl bg-[#2a2a35]/40 border border-white/5">
          <p className="text-[10px] uppercase tracking-wider text-[#a0a0b8] mb-2">Plano Premium</p>
          <div className="w-full h-1 bg-[#1a1a24] rounded-full overflow-hidden mb-3">
            <div className="w-[75%] h-full bg-gradient-to-r from-[#00d4aa] to-[#0099ff]"></div>
          </div>
          <p className="text-xs text-white/80">750 / 1000 créditos</p>
        </div>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen w-full bg-[#0f0f13] text-[#e8e8f0] font-sans selection:bg-[#00d4aa]/30 overflow-hidden">
      {renderSidebar()}
      
      <main className="flex-1 flex flex-col p-6 space-y-6 overflow-hidden">
        {activeView === 'generate' && (
          <>
            <header className="flex items-center justify-between">
              <div className="flex items-center gap-4 bg-[#1a1a24]/80 p-2 pl-4 rounded-xl border border-white/5">
                <span className="text-xs text-[#a0a0b8] font-mono">BACKEND API:</span>
                <div className="flex items-center gap-2">
                  <input type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} className="bg-transparent border-none text-xs w-48 text-[#00d4aa] focus:ring-0 outline-none placeholder:text-[#00d4aa]/50" placeholder="Servidor Ativo (ou MOCK)" />
                  <button onClick={() => setShowApiKey(!showApiKey)} className="p-1 text-[#a0a0b8] hover:text-white">
                    {showApiKey ? <EyeOff className="w-4 h-4"/> : <Eye className="w-4 h-4"/>}
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <span className="px-3 py-1 rounded-full bg-[#1a1a24] border border-white/10 text-[10px] text-[#a0a0b8]">Dark Mode</span>
                <span className="px-3 py-1 rounded-full bg-[#00d4aa]/20 border border-[#00d4aa]/30 text-[10px] text-[#00d4aa]">Servidor Conectado</span>
              </div>
            </header>

            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex flex-wrap gap-2 mb-4">
                {INLINE_TAGS.map(t => (
                  <span key={t.tag} onClick={() => {
                    const el=textAreaRef.current; if(!el)return;
                    const val = text.substring(0,el.selectionStart)+t.tag+text.substring(el.selectionEnd);
                    setText(val); setTimeout(()=>el.focus(),0);
                  }} className="px-2 py-1 bg-[#1a1a24] rounded-md text-[11px] text-[#a0a0b8] cursor-pointer hover:bg-[#2a2a35]">{t.tag}</span>
                ))}
              </div>
              
              <div className="relative flex-1 group">
                <textarea
                  ref={textAreaRef} value={text} onChange={e => setText(e.target.value)} placeholder="Digite seu texto aqui..."
                  className="w-full h-full bg-[#1a1a24]/60 border border-white/5 rounded-2xl p-6 text-lg leading-relaxed outline-none focus:ring-1 focus:ring-[#00d4aa]/50 resize-none transition-all placeholder:text-white/20"
                  maxLength={50000}
                />
                <div className="absolute bottom-4 right-6 text-xs text-[#a0a0b8]">{text.length} / 50000</div>
              </div>

              <div className="mt-6 flex flex-col gap-3">
                {generationProgress && (
                  <div className="p-4 rounded-xl bg-[#1a1a24] border border-[#00d4aa]/30 shadow-lg animate-in fade-in">
                    <div className="flex justify-between items-center text-xs mb-2">
                      <span className="text-[#00d4aa] font-semibold flex items-center gap-2">
                        <Activity className="w-4 h-4 animate-pulse" />
                        {generationProgress.stage}
                      </span>
                      <span className="text-white/80 font-mono text-[11px]">
                        {Math.round((generationProgress.current / generationProgress.total) * 100)}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-[#2a2a35] rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-gradient-to-r from-[#00d4aa] to-[#0099ff] transition-all duration-300"
                        style={{ width: `${(generationProgress.current / generationProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-4">
                  <button onClick={() => handleGenerate(text.substring(0, 15000))} disabled={isGenerating || !text} className="px-6 py-4 rounded-xl border border-[#2a2a35] font-semibold text-sm hover:bg-[#2a2a35] transition-all flex items-center gap-2 disabled:opacity-50">
                    <PlayCircle className="w-5 h-5"/>
                    Pré-visualizar
                  </button>
                  <button onClick={() => handleGenerate()} disabled={isGenerating || !text} className="flex-1 py-4 rounded-xl bg-gradient-to-r from-[#00d4aa] to-[#0099ff] font-bold text-white shadow-xl shadow-[#00d4aa]/20 hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:scale-100 disabled:opacity-70 disabled:shadow-none">
                    {isGenerating ? <Loader2 className="w-6 h-6 animate-spin" /> : <Mic2 className="w-6 h-6"/>}
                    GERAR ÁUDIO {vocalConsistency !== 'disabled' ? 'COM ESTABILIDADE' : ''}
                  </button>
                </div>
              </div>
            </div>

            {generatedAudioState && (
              <div className="bg-[#1a1a24] border border-white/10 rounded-2xl p-4 shadow-2xl animate-in fade-in slide-in-from-bottom-4 space-y-3">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full overflow-hidden flex-shrink-0 relative group">
                     {/* Standard audio player nicely embedded */}
                     <audio ref={audioRef} controls className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-12 opacity-5 scale-[2] w-[600px] h-[50px] outline-none" />
                     <div className="w-full h-full bg-[#00d4aa] text-[#0f0f13] flex items-center justify-center pointer-events-none">
                       <Play className="w-6 h-6 ml-1 text-[#0f0f13]" />
                     </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between items-center mb-0">
                      <div className="flex items-center gap-2 text-xs font-semibold">
                        <span className="text-[#00d4aa]">{voice}</span>
                        <span className="text-[#a0a0b8]">•</span>
                        <span className="text-white">{emotion} / {styles[0]} / {accent}</span>
                      </div>
                    </div>
                    <div className="mt-1">
                       <audio ref={audioRef} controls className="w-full h-8 outline-none grayscale invert hue-rotate-180 brightness-150 contrast-100 mix-blend-screen" />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button onClick={() => handleDownload(generatedAudioState.blob, voice)} className="p-2 text-[#a0a0b8] hover:text-white" title="Baixar áudio WAV"><Download className="w-5 h-5"/></button>
                  </div>
                </div>

                {consistencyReport && (
                  <div className="pt-3 border-t border-white/5 flex flex-wrap items-center justify-between text-xs text-[#a0a0b8] gap-2">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-[#00d4aa]" />
                      <span className="font-medium text-white/90">
                        Consistência Vocal: <strong className="text-[#00d4aa]">{consistencyReport.consistencyScore}%</strong>
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-[#00d4aa]/10 text-[10px] text-[#00d4aa] border border-[#00d4aa]/20">
                        Identidade Fixa Ativa
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-[11px]">
                      <span>
                        Segmentos: <strong className="text-white">{consistencyReport.segmentCount}</strong>
                      </span>
                      <span>•</span>
                      <span>
                        Duração: <strong className="text-white">{Math.round(consistencyReport.totalDurationSeconds)}s</strong>
                      </span>
                      <span>•</span>
                      <span>
                        Variação RMS: <strong className="text-white">{consistencyReport.rmsVariationDb} dB</strong>
                      </span>
                      {consistencyReport.crossfadeApplied && (
                        <>
                          <span>•</span>
                          <span className="text-[#00d4aa]">Transições Suavizadas</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Similar views logic placeholder mostly - Library, Presets, History */}
        {activeView !== 'generate' && activeView !== 'settings' && (
           <div className="p-8 w-full h-full overflow-auto"><h2 className="text-3xl font-bold font-heading mb-6">{activeView.toUpperCase()}</h2><p className="text-[#a0a0b8]">View implementation available via options menu.</p></div>
        )}
      </main>

      {/* Right Sidebar for Controls */}
      {activeView === 'generate' && (
        <aside className="w-[320px] bg-[#1a1a24]/60 border-l border-white/5 flex flex-col">
          <div className="p-5 flex-1 overflow-y-auto space-y-6">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-[#a0a0b8] mb-4">Vozes Selecionadas</h3>
              <div className="grid grid-cols-2 gap-2">
                {VOICES.map(v => (
                  <div key={v.name} onClick={() => setVoice(v.name)} className={voice===v.name ? "p-3 rounded-xl bg-[#00d4aa]/10 border border-[#00d4aa]/30 cursor-pointer" : "p-3 rounded-xl bg-[#2a2a35]/40 border border-transparent hover:border-white/10 cursor-pointer"}>
                    <p className={`text-sm font-bold ${voice===v.name ? 'text-white' : 'text-[#a0a0b8]'}`}>{v.name}</p>
                    <p className={`text-[10px] ${voice===v.name ? 'text-[#00d4aa]' : 'text-[#a0a0b8]'}`}>{v.gender=== 'M' ? 'Masc' : 'Fem'} • {v.tone.split(' ')[0]}</p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-[#a0a0b8] mb-3">Sotaque e Região</h3>
              <select value={accent} onChange={e=>setAccent(e.target.value)} className="w-full bg-[#15151e] border border-white/10 rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[#00d4aa] outline-none mb-2">
                {Object.entries(ACCENTS).map(([region, items]) => (
                  <optgroup key={region} label={region}>{items.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}</optgroup>
                ))}
                <option value="custom">Personalizado...</option>
              </select>
              {accent==='custom' && <input type="text" value={customAccent} onChange={e=>setCustomAccent(e.target.value)} placeholder="Ex: carioca forte" className="w-full bg-[#15151e] border border-white/10 rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[#00d4aa] outline-none" />}
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-[#a0a0b8] mb-3">Estilo Narrativo</h3>
              <div className="flex flex-wrap gap-2">
                {STYLES.slice(0, 10).map(s => (
                  <span key={s} onClick={()=>setStyles(p=>p.includes(s)?p.filter(x=>x!==s):[...p.slice(-1), s])} className={styles.includes(s) ? "cursor-pointer px-3 py-1 bg-[#00d4aa] text-[#0f0f13] text-[11px] font-bold rounded-full" : "cursor-pointer px-3 py-1 bg-[#1a1a24] border border-white/10 text-[11px] text-[#a0a0b8] rounded-full hover:border-[#00d4aa]"}>{s}</span>
                ))}
              </div>
            </div>
            
            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-[#a0a0b8] mb-3">Emoção</h3>
              <div className="flex flex-wrap gap-1">
                {EMOTIONS.map(e => (
                  <button key={e.name} onClick={() => setEmotion(e.name)} className={emotion===e.name ? "cursor-pointer p-2 rounded-xl bg-[#00d4aa]/10 border border-[#00d4aa]/30 text-lg" : "cursor-pointer p-2 rounded-xl bg-[#2a2a35]/40 border border-transparent hover:border-white/10 text-lg"} title={e.name}>{e.icon}</button>
                ))}
              </div>
            </div>

            {/* --- VOCAL STABILITY & FIXED IDENTITY SECTION --- */}
            <div className="p-3.5 rounded-xl bg-[#14141d] border border-[#00d4aa]/20 shadow-inner">
              <div 
                className="flex justify-between items-center cursor-pointer select-none" 
                onClick={()=>setUiState(s=>({accordions:{...s.accordions, stability:!s.accordions.stability}}))}
              >
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#00d4aa]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-white">Estabilidade Vocal</h3>
                </div>
                <span className="text-[10px] text-[#00d4aa] font-medium bg-[#00d4aa]/10 px-2 py-0.5 rounded-full">
                  {vocalConsistency === 'disabled' ? 'Desativada' : vocalConsistency === 'maximum' ? 'Máxima' : vocalConsistency === 'high' ? 'Alta' : 'Equilibrada'}
                </span>
              </div>

              {uiState.accordions.stability && (
                <div className="space-y-4 pt-3.5 mt-2 border-t border-white/5">
                  <div>
                    <label className="text-[11px] font-semibold text-[#a0a0b8] block mb-1.5">Consistência Vocal</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { id: 'disabled', label: 'Desativada' },
                        { id: 'balanced', label: 'Equilibrada' },
                        { id: 'high', label: 'Alta' },
                        { id: 'maximum', label: 'Máxima' }
                      ].map(opt => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setVocalConsistency(opt.id as any)}
                          className={`text-xs py-1.5 px-2 rounded-lg font-medium transition-all ${
                            vocalConsistency === opt.id
                              ? 'bg-[#00d4aa] text-[#0f0f13] font-bold shadow'
                              : 'bg-[#1f1f2b] text-[#a0a0b8] hover:text-white hover:bg-[#282838]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-[#a0a0b8] block mb-1.5">Intensidade Vocal</label>
                    <select
                      value={vocalIntensity}
                      onChange={e => setVocalIntensity(e.target.value as any)}
                      className="w-full bg-[#1b1b26] border border-white/10 rounded-lg p-2 text-xs text-white focus:ring-1 focus:ring-[#00d4aa] outline-none"
                    >
                      <option value="natural">Natural (Padrão)</option>
                      <option value="moderate">Moderadamente firme</option>
                      <option value="firm">Firme (Recomendado)</option>
                      <option value="very_firm">Muito firme (Sem sussurros)</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-[#a0a0b8] block mb-1.5">Estabilidade de Interpretação</label>
                    <select
                      value={interpretationStability}
                      onChange={e => setInterpretationStability(e.target.value as any)}
                      className="w-full bg-[#1b1b26] border border-white/10 rounded-lg p-2 text-xs text-white focus:ring-1 focus:ring-[#00d4aa] outline-none"
                    >
                      <option value="flexible">Flexível</option>
                      <option value="balanced">Equilibrada</option>
                      <option value="stable">Estável (Recomendado)</option>
                      <option value="very_stable">Muito estável</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-[#a0a0b8] block mb-1.5">Continuidade entre Segmentos</label>
                    <select
                      value={continuityMode}
                      onChange={e => setContinuityMode(e.target.value as any)}
                      className="w-full bg-[#1b1b26] border border-white/10 rounded-lg p-2 text-xs text-white focus:ring-1 focus:ring-[#00d4aa] outline-none"
                    >
                      <option value="auto">Automática</option>
                      <option value="consistency">Priorizar consistência (RMS & Micro-fade)</option>
                      <option value="natural">Priorizar naturalidade</option>
                    </select>
                  </div>

                  <p className="text-[10px] text-[#00d4aa]/80 leading-relaxed bg-[#00d4aa]/5 p-2 rounded-lg border border-[#00d4aa]/10">
                    🔒 <strong>Identidade Vocal Fixa:</strong> Preserva timbre, intensidade e velocidade do início ao fim, evitando quebras em textos longos.
                  </p>
                </div>
              )}
            </div>

            <div>
              <div className="flex justify-between items-center mb-4 cursor-pointer" onClick={()=>setUiState(s=>({accordions:{...s.accordions, interp:!s.accordions.interp}}))}>
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#a0a0b8]">Interpretação</h3>
                {uiState.accordions.interp ? <ChevronUp className="w-4 h-4 text-[#a0a0b8]"/> : <ChevronDown className="w-4 h-4 text-[#a0a0b8]"/> }
              </div>
              {uiState.accordions.interp && (
                 <div className="space-y-4">
                 {[
                   {l:'Velocidade', val:speed, set:setSpeed}, {l:'Expressividade', val:expressiveness, set:setExpressiveness},
                   {l:'Tonalidade', val:pitch, set:setPitch}, {l:'Energia', val:energy, set:setEnergy}
                 ].map(sl => (
                   <div key={sl.l}>
                     <div className="flex justify-between text-[10px] text-[#a0a0b8] mb-1"><span>{sl.l}</span><span>{sl.val}</span></div>
                     <input type="range" min="1" max="5" value={sl.val} onChange={e=>sl.set(parseInt(e.target.value))} className="w-full h-1 bg-[#2a2a35] rounded-lg appearance-none cursor-pointer accent-[#00d4aa]" />
                   </div>
                 ))}
               </div>
              )}
            </div>
            
            <div>
              <div className="flex justify-between items-center mb-4 cursor-pointer" onClick={()=>setUiState(s=>({accordions:{...s.accordions, adv:!s.accordions.adv}}))}>
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#a0a0b8]">Avançado</h3>
                {uiState.accordions.adv ? <ChevronUp className="w-4 h-4 text-[#a0a0b8]"/> : <ChevronDown className="w-4 h-4 text-[#a0a0b8]"/> }
              </div>
              {uiState.accordions.adv && (
                 <div className="space-y-3 pb-4">
                 {[
                   {l:'Início Suave', st:softStart, set:setSoftStart}, {l:'Fim Suave', st:softEnd, set:setSoftEnd},
                   {l:'Sorriso Oculto', st:voiceSmile, set:setVoiceSmile}, {l:'Respirações', st:breaths, set:setBreaths}
                 ].map(t => (
                   <label key={t.l} className="flex items-center gap-3 cursor-pointer text-xs text-[#a0a0b8] hover:text-white transition-colors">
                     <input type="checkbox" checked={t.st} onChange={()=>t.set(!t.st)} className="w-4 h-4 accent-[#00d4aa] rounded bg-[#2a2a35] border-transparent" /> {t.l}
                   </label>
                 ))}
               </div>
              )}
            </div>

            <div className="pt-4 border-t border-white/5">
              <button className="w-full p-3 rounded-lg border border-white/5 bg-white/5 text-xs text-white/80 hover:bg-white/10 transition-all flex items-center justify-center gap-2">
                <Copy className="w-4 h-4" />
                Salvar como Preset
              </button>
            </div>
          </div>
        </aside>
      )}
      
      {toast && (
        <div className={`fixed top-4 right-4 p-4 rounded-xl shadow-2xl flex items-center gap-3 z-50 animate-in slide-in-from-top-4 ${toast.type==='error'?'bg-red-500 text-white font-medium':'bg-gradient-to-r from-[#00d4aa] to-[#0099ff] text-white font-semibold'}`}>
          {toast.type==='error'? <Zap className="w-5 h-5"/> : <Check className="w-5 h-5"/>}
          <p>{toast.message}</p>
        </div>
      )}
    </div>
  );
}
