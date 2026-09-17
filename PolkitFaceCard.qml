import QtQuick

Item {
  id: root

  property QtObject chrome: null

  readonly property color tint: chrome && chrome.errorFlash ? chrome.errorColor : (chrome ? chrome.accent : "white")

  Column {
    anchors.centerIn: parent
    spacing: chrome ? chrome.gap : 10
    width: parent.width

    Item {
      width: Math.round(Math.min(parent.width, root.height * 0.6))
      height: width
      anchors.horizontalCenter: parent.horizontalCenter

      FaceScanRing {
        anchors.fill: parent
        color: root.tint
        running: !!root.chrome && root.chrome.active
        strokeWidth: chrome ? Math.max(2, chrome.lineWidth) : 2
      }

      Text {
        anchors.centerIn: parent
        text: chrome ? chrome.glyph : ""
        color: root.tint
        font.family: chrome ? chrome.fontFamily : "monospace"
        font.pixelSize: Math.round(parent.width * 0.55)
        renderType: Text.NativeRendering
      }
    }

    Text {
      width: parent.width
      text: chrome ? chrome.hint : ""
      color: chrome && chrome.errorFlash ? chrome.errorColor : (chrome ? chrome.foreground : "white")
      opacity: 0.72
      font.family: chrome ? chrome.fontFamily : "monospace"
      font.pixelSize: chrome ? chrome.hintFontSize : 11
      horizontalAlignment: Text.AlignHCenter
      elide: Text.ElideRight
    }
  }
}
