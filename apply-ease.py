
from pathlib import Path
import sys

frame_path = Path("FaceCardFrame.js")
test_path = Path("test/frame-test.js")
frame = frame_path.read_text()
test = test_path.read_text()

old_ease = "function easeOutBack(k) { var c = 1.9; var f = k - 1; return 1 + c * f * f * f + 1.2 * f * f }\n\n"
new_ease = """function easeOutBack(k) {
  // c3 is c1 + 1 so the curve is 0 at the start. A smaller cubic coefficient
  // leaves the gesture already partway seated when the lock begins.
  if (k <= 0) return 0
  if (k >= 1) return 1
  var c1 = 1.2
  var c3 = c1 + 1
  var f = k - 1
  return 1 + c3 * f * f * f + c1 * f * f
}

"""

old_test = """new Function('__out', body + '\\n__out.frame = frame; __out.holdMs = holdMs; __out.STYLE = STYLE; __out.STYLES = STYLES;')(exported)
const { frame, holdMs } = exported

"""
new_test = """new Function('__out', body + '\\n__out.frame = frame; __out.holdMs = holdMs; __out.STYLE = STYLE; __out.STYLES = STYLES; __out.easeOutBack = easeOutBack;')(exported)
const { frame, holdMs, easeOutBack } = exported

check('a lock ease starts at rest and ends seated', () => {
  assert.strictEqual(easeOutBack(0), 0)
  assert.strictEqual(easeOutBack(1), 1)
  assert.ok(easeOutBack(0.7) > 1, 'the back ease still overshoots before it settles')
})

"""

if frame.count(old_ease) != 1:
    sys.exit(f"ease count {frame.count(old_ease)}")
if test.count(old_test) != 1:
    sys.exit(f"test count {test.count(old_test)}")
frame_path.write_text(frame.replace(old_ease, new_ease, 1))
test_path.write_text(test.replace(old_test, new_test, 1))
