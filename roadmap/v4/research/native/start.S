.section .text.boot,"ax"
.global _start
.type _start,%function
_start:
    bl aether_eval
    hvc #0
1:  b 1b
