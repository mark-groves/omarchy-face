import QtQuick
import Quickshell

ShellRoot {
  ChromeStub {
    id: stub
  }

  FloatingWindow {
    title: "Polkit face preview"
    implicitWidth: 340
    implicitHeight: 180

    Rectangle {
      anchors.fill: parent
      color: "#1e1e2e"

      Loader {
        anchors.fill: parent
        anchors.margins: 16
        source: Qt.resolvedUrl("../PolkitFaceCard.qml")
        onLoaded: if (item && "chrome" in item) item.chrome = stub
      }
    }
  }
}
