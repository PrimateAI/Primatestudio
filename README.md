# Primate Studio

The web page of Primate Studio, a local analog/mixed-signal design environment: team chat with memory,
Primate DE schematics, PrimeSpice simulations and PrimeProbe waveforms.

**https://primateai.github.io/Primatestudio**

This repository is only the interface. The engine (the design teams, the designs, the simulator and the
language model) runs on the owner's PC and is reachable only inside the owner's private Tailscale
network, so the page works only on devices signed into that network. Anywhere else it shows "engine
offline", and nothing here can reach or change any design.

The files are copied from `serdes_agent/studio/static` of the serdes-agent project; `config.js` holds
the engine address.
