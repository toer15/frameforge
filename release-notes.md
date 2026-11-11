**Analog trigger graphics follow every partial press**

- The LT and RT triggers on the controller drawing now follow the exact analog value: pressing slowly fills the trigger and moves a bright marker to the precise press position instead of snapping on or off.
- The Gamepad API path used by Xbox and generic pads no longer treats a partly pressed trigger as fully pressed; it keeps the exact 0–100 % value. Sony pads read through WebHID were already analog, and Switch triggers stay digital.
- The Live input trigger percentages and the drawing now always match the physical trigger position.
- Everything else on the Controller tab is unchanged.
