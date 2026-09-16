import { isCJK } from './analysis.js'

export type SegmentMetrics = {
  width: number
  containsCJK: boolean
  emojiCount?: number
  breakableFitMode?: BreakableFitMode
  breakableFitAdvances?: number[] | null
}

export type EngineProfile = {
  lineFitEpsilon: number
  carryCJKAfterClosingQuote: boolean
  breakKeepAllAfterPunctuation: boolean
  preferPrefixWidthsForBreakableRuns: boolean
}

export type BreakableFitMode = 'sum-graphemes' | 'segment-prefixes' | 'pair-context'

type MeasureContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

let defaultContext: MeasureContext | null = null
export type MeasureDirection = 'ltr' | 'rtl'

let activeContext: MeasureContext | null = null
let activeDirection: MeasureDirection = 'ltr'
const featureContexts = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>()
const MAX_FEATURE_CONTEXTS = 16
const segmentMetricCaches = new Map<string, Map<string, SegmentMetrics>>()
let cachedEngineProfile: EngineProfile | null = null

// Safari's prefix-fit policy is useful for ordinary word-sized runs, but letting
// it measure every growing prefix of a giant segment recreates a pathological
// superlinear prepare-time path. Past this size, switch to the cheaper
// pair-context model and keep the public behavior linear.
const MAX_PREFIX_FIT_GRAPHEMES = 96

const emojiPresentationRe = /\p{Emoji_Presentation}/u
const maybeEmojiRe = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3]/u
let sharedGraphemeSegmenter: Intl.Segmenter | null = null
const emojiCorrectionCache = new Map<string, number>()

export function getMeasureContext(): MeasureContext {
  if (activeContext !== null) return activeContext
  return getDefaultContext()
}

function getDefaultContext(): MeasureContext {
  if (defaultContext !== null) return defaultContext

  if (typeof OffscreenCanvas !== 'undefined') {
    defaultContext = new OffscreenCanvas(1, 1).getContext('2d')!
    return defaultContext
  }

  if (typeof document !== 'undefined') {
    defaultContext = document.createElement('canvas').getContext('2d')!
    return defaultContext
  }

  throw new Error('Text measurement requires OffscreenCanvas or a DOM canvas context.')
}

// Canvas 2D contexts expose no font-feature control, but the CSS
// font-feature-settings of an in-document canvas element does apply to its
// context's measureText. OffscreenCanvas has no such channel, so feature
// measurement needs a DOM canvas per feature string; without a document (or
// before <body> exists) features are silently ignored.
function getFeatureContext(fontFeatureSettings: string): MeasureContext {
  const existing = featureContexts.get(fontFeatureSettings)
  if (existing !== undefined) return existing.ctx

  if (typeof document === 'undefined' || document.body === null) {
    return getDefaultContext()
  }

  if (featureContexts.size >= MAX_FEATURE_CONTEXTS) {
    for (const [key, entry] of featureContexts) {
      entry.canvas.remove()
      featureContexts.delete(key)
      break
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  // pinned and zero-sized: an auto-inset absolute element lands at its static
  // position after the page content, where even a hidden 1px box gives the
  // document a scrollbar (scrollable overflow counts absolutely positioned boxes)
  canvas.style.cssText = 'position: absolute; top: 0; left: 0; width: 0; height: 0; visibility: hidden'
  canvas.style.fontFeatureSettings = fontFeatureSettings
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')!
  featureContexts.set(fontFeatureSettings, { canvas, ctx })
  return ctx
}

export function getSegmentMetricCache(font: string): Map<string, SegmentMetrics> {
  let cache = segmentMetricCaches.get(font)
  if (!cache) {
    cache = new Map()
    segmentMetricCaches.set(font, cache)
  }
  return cache
}

export function getSegmentMetrics(seg: string, cache: Map<string, SegmentMetrics>): SegmentMetrics {
  let metrics = cache.get(seg)
  if (metrics === undefined) {
    const ctx = getMeasureContext()
    // measured in the paragraph direction, so a segment's edge neutrals resolve
    // into the run the browser puts them in (a Hebrew word's trailing modifiers
    // shape with the letter in an RTL paragraph, stand alone in an LTR one)
    if ('direction' in ctx) {
      ctx.direction = activeDirection
    }
    metrics = {
      width: ctx.measureText(seg).width,
      containsCJK: isCJK(seg),
    }
    cache.set(seg, metrics)
  }
  return metrics
}

export function getEngineProfile(): EngineProfile {
  if (cachedEngineProfile !== null) return cachedEngineProfile

  if (typeof navigator === 'undefined') {
    cachedEngineProfile = {
      lineFitEpsilon: 0.005,
      carryCJKAfterClosingQuote: false,
      breakKeepAllAfterPunctuation: true,
      preferPrefixWidthsForBreakableRuns: false,
    }
    return cachedEngineProfile
  }

  const ua = navigator.userAgent
  const vendor = navigator.vendor
  const isSafari =
    vendor === 'Apple Computer, Inc.' &&
    ua.includes('Safari/') &&
    !ua.includes('Chrome/') &&
    !ua.includes('Chromium/') &&
    !ua.includes('CriOS/') &&
    !ua.includes('FxiOS/') &&
    !ua.includes('EdgiOS/')
  const isChromium =
    ua.includes('Chrome/') ||
    ua.includes('Chromium/') ||
    ua.includes('CriOS/') ||
    ua.includes('Edg/')

  cachedEngineProfile = {
    lineFitEpsilon: isSafari ? 1 / 64 : 0.005,
    carryCJKAfterClosingQuote: isChromium,
    breakKeepAllAfterPunctuation: !isSafari,
    preferPrefixWidthsForBreakableRuns: isSafari,
  }
  return cachedEngineProfile
}

export function parseFontSize(font: string): number {
  const m = font.match(/(\d+(?:\.\d+)?)\s*px/)
  return m ? parseFloat(m[1]!) : 16
}

function getSharedGraphemeSegmenter(): Intl.Segmenter {
  if (sharedGraphemeSegmenter === null) {
    sharedGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  }
  return sharedGraphemeSegmenter
}

function isEmojiGrapheme(g: string): boolean {
  return emojiPresentationRe.test(g) || g.includes('\uFE0F')
}

export function textMayContainEmoji(text: string): boolean {
  return maybeEmojiRe.test(text)
}

function getEmojiCorrection(font: string, fontSize: number): number {
  let correction = emojiCorrectionCache.get(font)
  if (correction !== undefined) return correction

  const ctx = getMeasureContext()
  ctx.font = font
  const canvasW = ctx.measureText('\u{1F600}').width
  correction = 0
  if (
    canvasW > fontSize + 0.5 &&
    typeof document !== 'undefined' &&
    document.body !== null
  ) {
    const span = document.createElement('span')
    span.style.font = font
    span.style.display = 'inline-block'
    span.style.visibility = 'hidden'
    span.style.position = 'absolute'
    span.textContent = '\u{1F600}'
    document.body.appendChild(span)
    const domW = span.getBoundingClientRect().width
    document.body.removeChild(span)
    if (canvasW - domW > 0.5) {
      correction = canvasW - domW
    }
  }
  emojiCorrectionCache.set(font, correction)
  return correction
}

function countEmojiGraphemes(text: string): number {
  let count = 0
  const graphemeSegmenter = getSharedGraphemeSegmenter()
  for (const g of graphemeSegmenter.segment(text)) {
    if (isEmojiGrapheme(g.segment)) count++
  }
  return count
}

function getEmojiCount(seg: string, metrics: SegmentMetrics): number {
  if (metrics.emojiCount === undefined) {
    metrics.emojiCount = countEmojiGraphemes(seg)
  }
  return metrics.emojiCount
}

export function getCorrectedSegmentWidth(seg: string, metrics: SegmentMetrics, emojiCorrection: number): number {
  if (emojiCorrection === 0) return metrics.width
  return metrics.width - getEmojiCount(seg, metrics) * emojiCorrection
}

export function getFirstGrapheme(text: string): string {
  const graphemeSegmenter = getSharedGraphemeSegmenter()
  for (const gs of graphemeSegmenter.segment(text)) {
    return gs.segment
  }
  return text
}

// Browsers shape whole runs, so a segment's advance can depend on what follows
// it: required ligatures (e.g. Hebrew fonts that ligate a word-final letter
// only when its shaping lookahead — which can skip spaces — finds a following
// letter) and cross-boundary kerning. Measuring the segment together with a
// short following context and subtracting that context's own advance
// attributes the boundary interaction to the segment, and keeps per-line width
// sums telescoping to the whole-run measurement.
export function getContextualSegmentWidth(
  seg: string,
  metrics: SegmentMetrics,
  followingContext: string | null,
  cache: Map<string, SegmentMetrics>,
  emojiCorrection: number,
): number {
  const base = getCorrectedSegmentWidth(seg, metrics, emojiCorrection)
  if (followingContext === null) return base
  const pair = seg + followingContext
  const pairMetrics = getSegmentMetrics(pair, cache)
  const contextMetrics = getSegmentMetrics(followingContext, cache)
  const width =
    getCorrectedSegmentWidth(pair, pairMetrics, emojiCorrection) -
    getCorrectedSegmentWidth(followingContext, contextMetrics, emojiCorrection)
  return width > 0 ? width : base
}

export function getSegmentBreakableFitAdvances(
  seg: string,
  metrics: SegmentMetrics,
  cache: Map<string, SegmentMetrics>,
  emojiCorrection: number,
  mode: BreakableFitMode,
): number[] | null {
  if (metrics.breakableFitAdvances !== undefined && metrics.breakableFitMode === mode) {
    return metrics.breakableFitAdvances
  }
  metrics.breakableFitMode = mode

  const graphemeSegmenter = getSharedGraphemeSegmenter()
  const graphemes: string[] = []
  for (const gs of graphemeSegmenter.segment(seg)) {
    graphemes.push(gs.segment)
  }
  if (graphemes.length <= 1) {
    metrics.breakableFitAdvances = null
    return metrics.breakableFitAdvances
  }

  if (mode === 'sum-graphemes') {
    const advances: number[] = []
    for (const grapheme of graphemes) {
      const graphemeMetrics = getSegmentMetrics(grapheme, cache)
      advances.push(getCorrectedSegmentWidth(grapheme, graphemeMetrics, emojiCorrection))
    }
    metrics.breakableFitAdvances = advances
    return metrics.breakableFitAdvances
  }

  if (mode === 'pair-context' || graphemes.length > MAX_PREFIX_FIT_GRAPHEMES) {
    const advances: number[] = []
    let previousGrapheme: string | null = null
    let previousWidth = 0

    for (const grapheme of graphemes) {
      const graphemeMetrics = getSegmentMetrics(grapheme, cache)
      const currentWidth = getCorrectedSegmentWidth(grapheme, graphemeMetrics, emojiCorrection)

      if (previousGrapheme === null) {
        advances.push(currentWidth)
      } else {
        const pair = previousGrapheme + grapheme
        const pairMetrics = getSegmentMetrics(pair, cache)
        advances.push(getCorrectedSegmentWidth(pair, pairMetrics, emojiCorrection) - previousWidth)
      }

      previousGrapheme = grapheme
      previousWidth = currentWidth
    }

    metrics.breakableFitAdvances = advances
    return metrics.breakableFitAdvances
  }

  const advances: number[] = []
  let prefix = ''
  let prefixWidth = 0

  for (const grapheme of graphemes) {
    prefix += grapheme
    const prefixMetrics = getSegmentMetrics(prefix, cache)
    const nextPrefixWidth = getCorrectedSegmentWidth(prefix, prefixMetrics, emojiCorrection)
    advances.push(nextPrefixWidth - prefixWidth)
    prefixWidth = nextPrefixWidth
  }

  metrics.breakableFitAdvances = advances
  return metrics.breakableFitAdvances
}

export function getFontMeasurementState(
  font: string,
  needsEmojiCorrection: boolean,
  fontFeatureSettings?: string,
  direction: MeasureDirection = 'ltr',
): {
  cache: Map<string, SegmentMetrics>
  fontSize: number
  emojiCorrection: number
} {
  activeContext = fontFeatureSettings === undefined ? getDefaultContext() : getFeatureContext(fontFeatureSettings)
  activeContext.font = font
  activeDirection = direction
  const cache = getSegmentMetricCache(
    `${font}\u0000${fontFeatureSettings ?? ''}\u0000${direction}`,
  )
  const fontSize = parseFontSize(font)
  const emojiCorrection = needsEmojiCorrection ? getEmojiCorrection(font, fontSize) : 0
  return { cache, fontSize, emojiCorrection }
}

export function clearMeasurementCaches(): void {
  segmentMetricCaches.clear()
  emojiCorrectionCache.clear()
  sharedGraphemeSegmenter = null
  for (const entry of featureContexts.values()) {
    entry.canvas.remove()
  }
  featureContexts.clear()
  activeContext = null
}
