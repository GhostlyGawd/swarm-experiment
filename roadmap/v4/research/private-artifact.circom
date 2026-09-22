pragma circom 2.2.3;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

// Research statement: private program f(x)=slope*x+offset maps every integer
// x in [0,15] to [0,255]. Fixed enumeration is universal over this exact domain.
// context contains full public 256-bit identities as pairs of 128-bit limbs.
template PrivateAffineArtifact() {
    signal input slope;
    signal input offset;
    signal input salt;
    signal input context[10];
    signal input artifactCommitment;

    component slopeBits = Num2Bits(8);
    component offsetBits = Num2Bits(8);
    slopeBits.in <== slope;
    offsetBits.in <== offset;
    component contextBits[10];
    for (var i=0; i<10; i++) {
        contextBits[i] = Num2Bits(128);
        contextBits[i].in <== context[i];
    }
    component commitment = Poseidon(13);
    commitment.inputs[0] <== slope;
    commitment.inputs[1] <== offset;
    commitment.inputs[2] <== salt;
    for (var i=0; i<10; i++) commitment.inputs[i+3] <== context[i];
    commitment.out === artifactCommitment;

    component outputs[16];
    for (var x=0; x<16; x++) {
        outputs[x] = Num2Bits(8);
        outputs[x].in <== slope*x+offset;
    }
}
component main {public [context, artifactCommitment]} = PrivateAffineArtifact();
