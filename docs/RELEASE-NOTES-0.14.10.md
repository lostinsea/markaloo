# Markaloo 0.14.10

## Fixes

- Fixed cases where Back and Forward lost your place in View, including a
  resize bug that left Forward disabled after Back returned to a table row.
- Fixed lost reading positions when switching from View to Edit near Mermaid
  diagrams. If Edit restores your place inside a diagram, Raw opens at its
  matching code block, even on the first switch at high zoom.
