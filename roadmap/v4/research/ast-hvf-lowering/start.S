.section .text.boot,"ax"
.global _start
.type _start,%function
_start:
    bl aether_ast_guest
    hvc #0
1:  b 1b

/* Every synchronous exception reports its original ESR/FAR/ELR through HVC.
 * The vector table begins at the fixed 2 KiB offset from the image base. */
.p2align 11
.global _guest_vectors
_guest_vectors:
.rept 16
    b _guest_exception
    .balign 128
.endr
_guest_exception:
    mrs x0, esr_el1
    mrs x1, far_el1
    mrs x2, elr_el1
    mov x3, #0xeeee
    hvc #0
