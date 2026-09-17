import QtQuick

Item {
  id: root

  property color color: "#ffffff"
  property bool running: true
  property real strokeWidth: 2

  Canvas {
    id: ring
    anchors.fill: parent

    onPaint: {
      var ctx = getContext("2d")
      var side = Math.min(width, height)
      var inset = root.strokeWidth
      ctx.reset()
      ctx.strokeStyle = root.color
      ctx.lineWidth = root.strokeWidth
      ctx.lineCap = "round"
      ctx.beginPath()
      ctx.arc(width / 2, height / 2, Math.max(1, side / 2 - inset), 0.15 * Math.PI, 1.65 * Math.PI)
      ctx.stroke()
    }

    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()
  }

  onColorChanged: ring.requestPaint()

  RotationAnimation on rotation {
    from: 0
    to: 360
    duration: 1400
    loops: Animation.Infinite
    running: root.running && root.visible
  }
}
