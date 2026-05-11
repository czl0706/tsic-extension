# playV VS Code Extension

Local VS Code sidebar for dlab Verilog problems.

## Features

- Scans labs and problems from `playv.labsRoot` or `LABSROOT`.
- Shows `PASS`, `FAIL`, or `NULL` from `sim/result.txt`.
- Opens root-level `*.v` and `*.sv` files directly in VS Code.
- Provides a simulation placeholder command for the future runner.
- Opens `sim/wave.vcd` with VS Code, allowing a VCD extension to handle rendering.

## Development

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

Set `playv.labsRoot` to your labs directory, for example:

```json
{
  "playv.labsRoot": "fixtures"
}
```

`playv.labsRoot` can be:

- An absolute path, such as `/home/verilog/Desktop/dlab/public/labs`.
- A workspace-relative path, such as `fixtures/labs`.
- An environment-expanded path, such as `${env:LABSROOT}`.
- Omitted, in which case the extension falls back to `LABSROOT`, bundled fixtures, then `/home/verilog/Desktop/dlab/public/labs`.

On Ubuntu/Debian, install the simulator with:

```sh
sudo apt install iverilog
```

The extension runs `iverilog` and `vvp` from `PATH` by default. Set `playv.iverilogPath` or `playv.vvpPath` only if your tools are installed somewhere unusual.

## Recommended Extensions

This extension does not bundle Verilog syntax highlighting or waveform viewing. Install these separately:

- `mshr-h.veriloghdl` for Verilog/SystemVerilog language support.
- `lramseyer.vaporview` for VCD waveform viewing.
