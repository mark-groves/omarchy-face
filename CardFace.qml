import QtQuick
import QtQuick.Effects
import "FaceCardFrame.js" as FaceCard
import "FacePaint.js" as FacePaint
import "CardSchedule.js" as Schedule

// The standalone card: the glass, the bloom and the sharp strokes, which state
// shows when (CardSchedule.js), and the frame and paint pacing. Card.qml puts
// it in a layer-shell window and feeds it events through show(). It needs
// nothing but Qt Quick, so a plain qml6 window can load it as it is.
//
// Pacing. frame() and the paint replay run on the GUI thread and the raster on
// Qt's canvas thread, so each layer keeps one paint in flight and a new frame
// is built only once the previous sharp paint has landed: every frame built is
// painted, and a slow raster drops frames instead of queueing them. The
// timeline follows the wall clock, so a slow frame never slows the boot or a
// result's beat. When frame() plus the raster overrun two refreshes the sharp
// layer steps down a quality level (rasterised smaller and scaled up, the
// bloom refreshed less often) and steps back up once the larger raster would
// fit again. A new level's layer replaces the old one only once it has
// painted, so a step never blanks the card.
//
// Motion. The card fades and grows in once its first frame has painted, and
// fades and shrinks out after the schedule's last beat, both on the render
// thread (Animators), so a busy GUI thread cannot stall them.
//
// Probe lines, one JSON object each, for the face verification harness:
//   face-probe-event {surface, state, t, rect, window}   every state change,
//                    and "closing" and "hidden" as the card leaves
//   face-probe {surface, shownAt, firstSwapAt, hiddenAt, swaps, ticks, paints,
//               swapGapMs, frameMs, paintMs, quality, moved}   once a showing ends
Item {
  id: root

  property int side: 220
  property string style: FaceCard.DEFAULT_STYLE
  property var theme: FacePaint.FALLBACK
  // The bloom needs a GPU; on the software scene graph the card is drawn sharp.
  property bool bloom: root.GraphicsInfo.api !== GraphicsInfo.Software
  // Through the host's Style.duration() and Style.easeOut, so turning
  // animations off turns these off too.
  property int enterMs: 180
  property int exitMs: 120
  property var easeOut: [0.23, 1.0, 0.32, 1.0, 1.0, 1.0]
  // Named in the probe lines.
  property string surface: "sudo"
  property string windowName: ""

  // The window must be mapped while this holds: from the first event of a
  // showing until its exit has played out.
  readonly property bool needsWindow: root.schedule.phase !== "closed"
  readonly property string phase: root.schedule.phase
  readonly property string shownState: root.schedule.phase === "closed" ? "" : root.schedule.state
  readonly property int queued: root.schedule.queue.length
  // The last finished showing's face-probe object, for `face-card stats`.
  property var lastProbe: null
  property int lastGlowPaints: 0
  signal probe(string kind, var data)

  implicitWidth: root.side
  implicitHeight: root.side

  readonly property int opLevel: 3
  readonly property var glassTheme: FacePaint.deriveGlass(root.theme)
  readonly property var roles: root.glassTheme.roles

  // A scan that never gets a verdict leaves after howdy's timeout (its
  // timeouts land 4.2 to 4.4 s after the scan start) and a margin for journal
  // delivery.
  readonly property int noVerdictMs: 5000
  // Reading time after the art's own hold, when the art gives no result beat.
  readonly property int lingerMs: 500

  // How long a result plays before anything replaces it or the card leaves:
  // the art's resultMs when it gives one, else its hold and a short linger.
  function beatMs(state) {
    var given = FaceCard.resultMs
    var ms = typeof given === "function" ? Number(given(state)) : Number(given)
    if (ms > 0) return ms
    return Math.max(0, Number(FaceCard.holdMs(state)) || 0) + root.lingerMs
  }

  readonly property var timing: ({
    scanMs: Math.max(0, Number(FaceCard.scanMs()) || 0),
    noVerdictMs: root.noVerdictMs,
    beatMs: function (state) { return root.beatMs(state) }
  })

  property var schedule: Schedule.initial()

  // scanning | recognized | notRecognized | cancel
  function show(state) {
    root.apply(Schedule.input(root.schedule, state, Date.now(), root.timing))
  }

  // Leaves now, dropping anything queued.
  function close() {
    root.apply(Schedule.close(root.schedule))
  }

  function advance() {
    root.apply(Schedule.advance(root.schedule, Date.now(), root.timing))
  }

  function apply(next) {
    var prev = root.schedule
    if (next === prev) return
    root.schedule = next
    var now = Date.now()
    if (prev.phase === "closed" && next.phase !== "closed") root.beginShowing(now)
    if (next.phase === "open" && (prev.phase !== "open" || prev.state !== next.state || prev.since !== next.since))
      root.noteState(next.state, now)
    if (next.phase === "open" && prev.phase === "closing") root.enter()
    if (next.phase === "closed" && prev.phase !== "closed") root.endShowing(now)
    root.armDeadline()
    if (next.phase === "closing" && prev.phase !== "closing") {
      root.noteState("closing", now)
      root.leave()
    }
  }

  // Frames drive the schedule while the card is up; this covers a window that
  // is not presenting.
  Timer {
    id: deadlineTimer
    onTriggered: root.advance()
  }

  function armDeadline() {
    var at = Schedule.deadline(root.schedule, root.timing)
    if (at <= 0) {
      deadlineTimer.stop()
      return
    }
    deadlineTimer.interval = Math.max(1, Math.ceil(at - Date.now()))
    deadlineTimer.restart()
  }

  // --- a showing -----------------------------------------------------------

  // The art's free-running clock: wall time while the card is up, carried
  // over from one showing to the next.
  property real clockBase: 0
  property real showingStart: 0
  function clockAt(now) { return root.clockBase + Math.max(0, now - root.showingStart) }

  // Set once a sharp layer has painted in this showing. Until then the layers
  // stay hidden, so a frame left from the last showing never shows.
  property bool contentReady: false
  property bool awaitingEntrance: false
  property var stats: null
  property var firstRect: null
  property bool moved: false
  property real lastSwapAt: 0

  function beginShowing(now) {
    root.showingStart = now
    root.contentReady = false
    root.awaitingEntrance = true
    root.firstRect = null
    root.moved = false
    root.lastSwapAt = 0
    root.frameCalls = 0
    root.frameEma = 0
    root.levelSamples = 0
    root.paintEma = 0
    root.stats = {
      shownAt: now, firstSwapAt: 0, swaps: 0, ticks: 0, paints: 0, glowPaints: 0, gaps: [],
      frameN: 0, frameSum: 0, frameMax: 0, paintN: 0, paintSum: 0, paintMax: 0
    }
    entranceGrace.restart()
  }

  function endShowing(now) {
    entranceGrace.stop()
    root.awaitingEntrance = false
    root.clockBase = root.clockAt(now)
    root.noteState("hidden", now)
    var s = root.stats
    if (!s) return
    var line = {
      surface: root.surface,
      shownAt: s.shownAt,
      firstSwapAt: s.firstSwapAt,
      hiddenAt: now,
      swaps: s.swaps,
      ticks: s.ticks,
      paints: s.paints,
      swapGapMs: { p50: root.percentile(s.gaps, 0.5), p95: root.percentile(s.gaps, 0.95), max: root.percentile(s.gaps, 1) },
      frameMs: { mean: root.tenths(s.frameN ? s.frameSum / s.frameN : 0), max: s.frameMax },
      paintMs: { mean: root.tenths(s.paintN ? s.paintSum / s.paintN : 0), max: s.paintMax },
      quality: root.qualityLevel,
      moved: root.moved
    }
    root.lastProbe = line
    root.lastGlowPaints = s.glowPaints
    console.log("face-probe " + JSON.stringify(line))
    root.probe("face-probe", line)
  }

  function tenths(v) { return Math.round(v * 10) / 10 }

  function percentile(list, p) {
    if (!list.length) return 0
    var sorted = list.slice().sort(function (a, b) { return a - b })
    return sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))]
  }

  // The card's place in its window, whatever its entrance scale is doing.
  function cardRect() {
    var p = root.mapToItem(null, 0, 0)
    return { x: Math.round(p.x), y: Math.round(p.y), w: root.side, h: root.side }
  }

  function noteState(state, now) {
    var rect = root.cardRect()
    if (!root.firstRect) root.firstRect = rect
    else if (rect.x !== root.firstRect.x || rect.y !== root.firstRect.y || rect.w !== root.firstRect.w || rect.h !== root.firstRect.h)
      root.moved = true
    var event = { surface: root.surface, state: state, t: now, rect: rect, window: root.windowName }
    console.log("face-probe-event " + JSON.stringify(event))
    root.probe("face-probe-event", event)
  }

  Connections {
    target: root.Window.window
    function onFrameSwapped() {
      var s = root.stats
      if (!s || root.schedule.phase === "closed") return
      var now = Date.now()
      s.swaps++
      if (root.lastSwapAt > 0 && s.gaps.length < 2000) s.gaps.push(now - root.lastSwapAt)
      root.lastSwapAt = now
      if (s.firstSwapAt === 0 && root.contentReady) s.firstSwapAt = now
    }
  }

  // --- motion ----------------------------------------------------------------

  function enter() {
    entranceGrace.stop()
    root.awaitingEntrance = false
    exitAnimation.stop()
    enterAnimation.restart()
  }

  function leave() {
    entranceGrace.stop()
    root.awaitingEntrance = false
    enterAnimation.stop()
    exitAnimation.restart()
  }

  // The entrance waits for the first painted frame, but not for long.
  Timer {
    id: entranceGrace
    interval: 250
    onTriggered: if (root.awaitingEntrance) root.enter()
  }

  ParallelAnimation {
    id: enterAnimation
    OpacityAnimator { target: card; to: 1; duration: root.enterMs; easing.type: Easing.OutCubic }
    ScaleAnimator { target: card; to: 1; duration: root.enterMs; easing.type: Easing.Bezier; easing.bezierCurve: root.easeOut }
  }

  ParallelAnimation {
    id: exitAnimation
    OpacityAnimator { target: card; to: 0; duration: root.exitMs; easing.type: Easing.OutCubic }
    ScaleAnimator { target: card; to: 0.97; duration: root.exitMs; easing.type: Easing.OutCubic }
    onFinished: root.apply(Schedule.finishClose(root.schedule))
  }

  // --- frames ----------------------------------------------------------------

  property var ops: []
  property int dispatches: 0
  // A paint that has not landed after this is taken as lost.
  readonly property int paintStallMs: 500

  FrameAnimation {
    running: root.schedule.phase !== "closed"
    onTriggered: {
      if (root.stats) root.stats.ticks++
      root.advance()
      root.pump()
    }
  }

  // Builds and dispatches the next frame if the last sharp paint has landed.
  function pump() {
    var s = root.schedule
    var layer = root.targetLayer
    if (s.phase === "closed" || !layer || !layer.available) return
    var now = Date.now()
    if (layer.inFlightSince > 0 && now - layer.inFlightSince < root.paintStallMs) return
    root.ops = FaceCard.frame(root.side, {
      state: s.state, clock: root.clockAt(now), elapsed: Math.max(0, now - s.since), host: root.opLevel,
      style: root.style
    })
    var built = Date.now()
    root.noteFrame(built - now)
    layer.inFlightSince = built
    layer.requestPaint()
    root.dispatches++
    if (root.bloom && root.dispatches % root.glowEvery === 0 && glowLayer.available
        && !(glowLayer.inFlightSince > 0 && built - glowLayer.inFlightSince < root.paintStallMs)) {
      glowLayer.inFlightSince = built
      glowLayer.requestPaint()
    }
  }

  function noteFrame(ms) {
    var s = root.stats
    if (s) {
      s.frameN++
      s.frameSum += ms
      if (ms > s.frameMax) s.frameMax = ms
    }
    // The first calls after a load pay the JS engine's warm-up.
    root.frameCalls++
    if (root.frameCalls > 2) root.frameEma = root.frameCalls === 3 ? ms : root.frameEma * 0.7 + ms * 0.3
  }

  function layerPainted(layer) {
    var now = Date.now()
    var dispatched = layer.inFlightSince
    layer.inFlightSince = 0
    if (layer !== root.targetLayer) return
    var s = root.stats
    if (s && dispatched > 0) {
      var ms = now - dispatched
      s.paints++
      s.paintN++
      s.paintSum += ms
      if (ms > s.paintMax) s.paintMax = ms
      root.notePaint(ms)
    }
    if (root.liveLayer !== layer) root.retire(root.liveLayer, layer)
    if (!root.contentReady && root.schedule.phase !== "closed") root.contentReady = true
    if (root.awaitingEntrance && root.schedule.phase === "open") root.enter()
  }

  // --- quality ---------------------------------------------------------------

  readonly property var qualityLevels: [
    { sharp: 1, glowEvery: 1 },
    { sharp: 0.75, glowEvery: 2 },
    { sharp: 0.5, glowEvery: 3 }
  ]
  // Two refreshes at 60 Hz: past this a frame is held on screen for three.
  readonly property int frameBudgetMs: 33
  // Kept for the life of the plugin, so a showing starts where the last ended.
  property int qualityLevel: 0
  readonly property int glowEvery: root.qualityLevels[root.qualityLevel].glowEvery
  property int frameCalls: 0
  property real frameEma: 0
  property real paintEma: 0
  property int levelSamples: 0

  // Raster time grows a little faster than the layer's side.
  function rasterGrowth(from, to) {
    return Math.pow(root.qualityLevels[to].sharp / root.qualityLevels[from].sharp, 1.2)
  }

  // ms is one sharp paint, dispatch to landed: the replay and the raster, not
  // frame(), which no quality step makes cheaper.
  function notePaint(ms) {
    root.levelSamples++
    var n = root.levelSamples - 2
    if (n < 1) return
    root.paintEma = n === 1 ? ms : root.paintEma * 0.7 + ms * 0.3
    var level = root.qualityLevel
    if (n >= 6 && level < root.qualityLevels.length - 1 && root.frameEma + root.paintEma > root.frameBudgetMs)
      root.setQuality(level + 1)
    else if (n >= 30 && level > 0
        && root.frameEma + root.paintEma * root.rasterGrowth(level, level - 1) < root.frameBudgetMs * 0.8)
      root.setQuality(level - 1)
  }

  function setQuality(level) {
    console.log("face-card quality level", level, "frame", Math.round(root.frameEma), "ms paint", Math.round(root.paintEma), "ms")
    root.qualityLevel = level
    root.levelSamples = 0
    root.paintEma = 0
    root.layerSerial++
    var key = level + ":" + root.layerSerial
    // The slot not on show; a layer still waiting for its first paint there
    // is replaced.
    if (root.liveLayer && root.liveLayer.slot === "A") root.slotB = key
    else root.slotA = key
  }

  // --- layers ----------------------------------------------------------------

  // The sharp layer lives in one of two slots. A quality step builds the new
  // layer in the free slot and paints into it; the old one stays on screen
  // until the new one has painted, then its slot is emptied.
  property string slotA: "0:0"
  property string slotB: ""
  property int layerSerial: 0
  property Canvas targetLayer: null
  property Canvas liveLayer: null

  function layerCreated(layer) {
    root.targetLayer = layer
    if (!root.liveLayer) root.liveLayer = layer
    root.pump()
  }

  function layerDestroyed(layer) {
    if (root.targetLayer === layer) root.targetLayer = root.liveLayer !== layer ? root.liveLayer : null
    if (root.liveLayer === layer) root.liveLayer = root.targetLayer
  }

  function retire(old, layer) {
    root.liveLayer = layer
    if (!old) return
    if (old.slot === "A") root.slotA = ""
    else root.slotB = ""
  }

  Component {
    id: sharpLayerComponent

    Canvas {
      id: sharpLayer

      required property string modelData
      property string slot: ""
      readonly property int level: Number(sharpLayer.modelData.split(":")[0])

      // Sized in logical pixels: Qt rasterises a Canvas at its size times the
      // window's device pixel ratio already.
      width: Math.max(1, Math.round(root.side * root.qualityLevels[sharpLayer.level].sharp))
      height: width
      scale: root.side / width
      transformOrigin: Item.TopLeft
      smooth: true
      renderTarget: Canvas.Image
      renderStrategy: Canvas.Threaded
      visible: root.contentReady && root.liveLayer === sharpLayer

      property real inFlightSince: 0

      Component.onCompleted: root.layerCreated(sharpLayer)
      Component.onDestruction: root.layerDestroyed(sharpLayer)

      onPaint: FacePaint.paintOps(getContext("2d"), root.ops, false, width / root.side, root.roles, true)
      onPainted: root.layerPainted(sharpLayer)
      onAvailableChanged: {
        inFlightSince = 0
        if (available) root.pump()
      }
    }
  }

  Item {
    id: card
    width: root.side
    height: root.side
    opacity: 0
    scale: 0.97

    Rectangle {
      anchors.fill: parent
      radius: Math.round(root.side * 0.045)
      border.width: 1
      border.color: root.glassTheme.edge
      gradient: Gradient {
        GradientStop { position: 0; color: Qt.tint(root.glassTheme.panel, Qt.alpha(root.glassTheme.edge, 0.55)) }
        GradientStop { position: 0.45; color: root.glassTheme.panel }
        GradientStop { position: 1; color: root.glassTheme.panel }
      }
    }

    // A half-resolution glow layer blurred twice on the GPU, a tight halo
    // and a wide bloom, under the sharp strokes. Its size never changes,
    // because a MultiEffect keeps the size its source had when it started.
    Canvas {
      id: glowLayer
      width: root.side / 2
      height: root.side / 2
      visible: false
      renderTarget: Canvas.Image
      renderStrategy: Canvas.Threaded

      property real inFlightSince: 0

      onPaint: FacePaint.paintOps(getContext("2d"), root.ops, true, 0.5, root.roles, true)
      onPainted: {
        inFlightSince = 0
        if (root.stats) root.stats.glowPaints++
      }
      onAvailableChanged: inFlightSince = 0
    }
    MultiEffect {
      anchors.fill: parent
      source: glowLayer
      visible: root.bloom && root.contentReady
      autoPaddingEnabled: true
      blurEnabled: true
      blur: 1.0
      blurMax: 48
      blurMultiplier: 0.6
      opacity: 0.95
    }
    MultiEffect {
      anchors.fill: parent
      source: glowLayer
      visible: root.bloom && root.contentReady
      autoPaddingEnabled: true
      blurEnabled: true
      blur: 0.55
      blurMax: 12
    }

    Repeater {
      model: root.slotA !== "" ? [root.slotA] : []
      delegate: sharpLayerComponent
      onItemAdded: (index, item) => item.slot = "A"
    }
    Repeater {
      model: root.slotB !== "" ? [root.slotB] : []
      delegate: sharpLayerComponent
      onItemAdded: (index, item) => item.slot = "B"
    }
  }
}
