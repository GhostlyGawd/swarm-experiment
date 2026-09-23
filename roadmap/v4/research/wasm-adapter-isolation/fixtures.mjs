// Hand-encoded, validated WebAssembly binaries. The admitted module is:
// (module (func (export "run") (param i32) (result i32)
//   local.get 0 i32.const 1 i32.add))
export const PURE_PLUS_ONE = Buffer.from(
  '0061736d0100000001060160017f017f030201000707010372756e00000a09010700200041016a0b', 'hex');

// This valid module imports a function named aether.emit and calls it from run.
// The research admission policy intentionally permits no imports at all.
export const FORGED_IMPORT = Buffer.from(
  '0061736d01000000010a0260017f017f60017f00020f010661657468657204656d69740001030201000707010372756e00010a0a0108002000100020000b', 'hex');
