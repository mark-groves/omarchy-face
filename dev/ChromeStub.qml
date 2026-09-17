import QtQuick

QtObject {
  property string kind: "face"
  property bool active: true
  property string glyph: "\uDB80\uDE08"
  property string hint: "Look at the camera"
  property color accent: "#89b4fa"
  property color foreground: "#cdd6f4"
  property color errorColor: "#f38ba8"
  property bool errorFlash: false
  property string fontFamily: "monospace"
  property int hintFontSize: 11
  property real lineWidth: 2
  property real gap: 10
}
