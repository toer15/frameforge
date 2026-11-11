**Static controller drawing and scaled square deadzone**

- The controller drawing on the **Controller** tab now stays still. It no longer rotates or follows the controller in your hands, so the buttons, sticks and yellow deadzone rings are always easy to read.
- Motion sensors still work: DualSense, DualShock 4, Switch Pro and Joy-Con tilt and turning speed are shown in **Live input**.
- Stick input now uses an explicit **scaled square (axial) deadzone**: X and Y are judged independently, values inside the deadzone read zero, and the remaining travel is linearly rescaled to full range. The cubic aim curve is applied after that.
- The per-stick deadzone sliders and yellow deadzone rings are unchanged.
