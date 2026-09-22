	.build_version macos, 26, 0	sdk_version 27, 0
	.section	__TEXT,__text,regular,pure_instructions
	.globl	_main                           ; -- Begin function main
	.p2align	2
_main:                                  ; @main
	.cfi_startproc
; %bb.0:
	stp	x28, x27, [sp, #-96]!           ; 16-byte Folded Spill
	stp	x26, x25, [sp, #16]             ; 16-byte Folded Spill
	stp	x24, x23, [sp, #32]             ; 16-byte Folded Spill
	stp	x22, x21, [sp, #48]             ; 16-byte Folded Spill
	stp	x20, x19, [sp, #64]             ; 16-byte Folded Spill
	stp	x29, x30, [sp, #80]             ; 16-byte Folded Spill
	add	x29, sp, #80
	sub	sp, sp, #592
	.cfi_def_cfa w29, 16
	.cfi_offset w30, -8
	.cfi_offset w29, -16
	.cfi_offset w19, -24
	.cfi_offset w20, -32
	.cfi_offset w21, -40
	.cfi_offset w22, -48
	.cfi_offset w23, -56
	.cfi_offset w24, -64
	.cfi_offset w25, -72
	.cfi_offset w26, -80
	.cfi_offset w27, -88
	.cfi_offset w28, -96
Lloh0:
	adrp	x8, ___stack_chk_guard@GOTPAGE
Lloh1:
	ldr	x8, [x8, ___stack_chk_guard@GOTPAGEOFF]
Lloh2:
	ldr	x8, [x8]
	stur	x8, [x29, #-96]
	cmp	w0, #3
	b.ne	LBB0_4
; %bb.1:
	mov	x22, x1
	str	xzr, [sp, #408]
	bl	___error
	str	wzr, [x0]
	ldr	x0, [x22, #16]
	add	x1, sp, #408
	mov	w2, #10                         ; =0xa
	bl	_strtol
	mov	x19, x0
	bl	___error
	ldr	w9, [x0]
	ldr	x8, [sp, #408]
	cmp	w9, #0
	ccmp	x8, #0, #4, eq
	b.eq	LBB0_3
; %bb.2:
	ldrb	w8, [x8]
	mov	x9, #-34465                     ; =0xffffffffffff795f
	movk	x9, #65534, lsl #16
	add	x10, x19, x9
	add	x9, x9, #1
	cmp	w8, #0
	ccmp	x10, x9, #0, eq
	b.hs	LBB0_10
LBB0_3:
Lloh3:
	adrp	x8, l_.str.1@PAGE
Lloh4:
	add	x8, x8, l_.str.1@PAGEOFF
	b	LBB0_5
LBB0_4:
Lloh5:
	adrp	x8, l_.str@PAGE
Lloh6:
	add	x8, x8, l_.str@PAGEOFF
LBB0_5:
	str	xzr, [sp, #8]
LBB0_6:
	str	x8, [sp]
Lloh7:
	adrp	x0, l_.str.38@PAGE
Lloh8:
	add	x0, x0, l_.str.38@PAGEOFF
	bl	_printf
Lloh9:
	adrp	x8, ___stdoutp@GOTPAGE
Lloh10:
	ldr	x8, [x8, ___stdoutp@GOTPAGEOFF]
Lloh11:
	ldr	x0, [x8]
	bl	_fflush
LBB0_7:
	mov	w0, #2                          ; =0x2
LBB0_8:
	ldur	x8, [x29, #-96]
Lloh12:
	adrp	x9, ___stack_chk_guard@GOTPAGE
Lloh13:
	ldr	x9, [x9, ___stack_chk_guard@GOTPAGEOFF]
Lloh14:
	ldr	x9, [x9]
	cmp	x9, x8
	b.ne	LBB0_103
; %bb.9:
	add	sp, sp, #592
	ldp	x29, x30, [sp, #80]             ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #64]             ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #48]             ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #32]             ; 16-byte Folded Reload
	ldp	x26, x25, [sp, #16]             ; 16-byte Folded Reload
	ldp	x28, x27, [sp], #96             ; 16-byte Folded Reload
	ret
LBB0_10:
	bl	_mach_absolute_time
	mov	x24, x0
Lloh15:
	adrp	x20, _timebase@PAGE
Lloh16:
	add	x20, x20, _timebase@PAGEOFF
	mov	x0, x20
	bl	_mach_timebase_info
	cbz	w0, LBB0_12
; %bb.11:
Lloh17:
	adrp	x8, l_.str.2@PAGE
Lloh18:
	add	x8, x8, l_.str.2@PAGEOFF
	b	LBB0_5
LBB0_12:
	bl	_getpagesize
                                        ; kill: def $w0 killed $w0 def $x0
	sxtw	x21, w0
	lsr	w8, w0, #16
	cbnz	w8, LBB0_17
; %bb.13:
	mov	w8, #65536                      ; =0x10000
	udiv	x23, x8, x21
	smsubl	x8, w23, w0, x8
	cbnz	x8, LBB0_17
; %bb.14:
	ldr	x0, [x22, #8]
Lloh19:
	adrp	x1, l_.str.4@PAGE
Lloh20:
	add	x1, x1, l_.str.4@PAGEOFF
	bl	_fopen
	cbz	x0, LBB0_18
; %bb.15:
	mov	x25, x0
	mov	x1, #0                          ; =0x0
	mov	w2, #2                          ; =0x2
	bl	_fseek
	cbz	w0, LBB0_19
; %bb.16:
	bl	___error
	ldrsw	x1, [x0]
Lloh21:
	adrp	x0, l_.str.6@PAGE
Lloh22:
	add	x0, x0, l_.str.6@PAGEOFF
	b	LBB0_101
LBB0_17:
Lloh23:
	adrp	x8, l_.str.3@PAGE
Lloh24:
	add	x8, x8, l_.str.3@PAGEOFF
	str	x21, [sp, #8]
	b	LBB0_6
LBB0_18:
	bl	___error
	ldrsw	x1, [x0]
Lloh25:
	adrp	x0, l_.str.5@PAGE
Lloh26:
	add	x0, x0, l_.str.5@PAGEOFF
	b	LBB0_101
LBB0_19:
	mov	x0, x25
	bl	_ftell
	mov	x27, x0
	mov	x0, x25
	bl	_rewind
	cmp	x27, #1
	b.lt	LBB0_97
; %bb.20:
	cmp	x27, x21
	b.hi	LBB0_97
; %bb.21:
	mov	x0, x27
	bl	_malloc
	cbz	x0, LBB0_98
; %bb.22:
	str	x0, [sp, #264]                  ; 8-byte Folded Spill
	mov	w1, #1                          ; =0x1
	mov	x2, x27
	mov	x3, x25
	bl	_fread
	cmp	x0, x27
	b.ne	LBB0_99
; %bb.23:
	mov	x0, x25
	bl	_fclose
	str	wzr, [sp, #404]
	add	x0, sp, #404
	bl	_hv_vm_get_max_vcpu_count
                                        ; kill: def $w0 killed $w0 def $x0
	cbnz	w0, LBB0_100
; %bb.24:
	ldr	w8, [sp, #404]
	cbz	w8, LBB0_100
; %bb.25:
	bl	_resident_now
	str	x0, [sp, #360]                  ; 8-byte Folded Spill
	sub	x1, x29, #256
	mov	w0, #0                          ; =0x0
	bl	_getrusage
	ldur	x8, [x29, #-224]
	cmp	w0, #0
	csel	x22, x8, xzr, eq
	bl	_getpid
                                        ; kill: def $w0 killed $w0 def $x0
	str	x0, [sp, #352]                  ; 8-byte Folded Spill
	ldp	w26, w28, [x20]
	ldr	w25, [sp, #404]
	bl	_mach_absolute_time
	sub	x8, x0, x24
	ucvtf	d0, x8
	ldp	s1, s2, [x20]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	ldp	x8, x9, [sp, #352]              ; 16-byte Folded Reload
	stp	x9, x22, [sp, #64]
	stp	x27, x25, [sp, #40]
	str	x27, [sp, #272]                 ; 8-byte Folded Spill
	stp	x28, x21, [sp, #24]
	stp	x19, x26, [sp, #8]
	str	x8, [sp]
Lloh27:
	adrp	x0, l_.str.11@PAGE
Lloh28:
	add	x0, x0, l_.str.11@PAGEOFF
	str	d0, [sp, #56]
	bl	_printf
Lloh29:
	adrp	x8, ___stdoutp@GOTPAGE
Lloh30:
	ldr	x8, [x8, ___stdoutp@GOTPAGEOFF]
Lloh31:
	ldr	x0, [x8]
	bl	_fflush
	stp	xzr, xzr, [sp, #248]            ; 16-byte Folded Spill
	stp	xzr, xzr, [sp, #232]            ; 16-byte Folded Spill
	mov	x24, #0                         ; =0x0
	mov	w8, #65536                      ; =0x10000
	sub	x8, x8, x21
	stp	xzr, x8, [sp, #216]             ; 16-byte Folded Spill
	dup.2d	v0, x21
	str	q0, [sp, #192]                  ; 16-byte Folded Spill
LBB0_26:                                ; =>This Loop Header: Depth=1
                                        ;     Child Loop BB0_68 Depth 2
                                        ;     Child Loop BB0_70 Depth 2
	stp	xzr, xzr, [sp, #384]
	mov	w8, #200                        ; =0xc8
	mov	x9, #1000                       ; =0x3e8
	madd	x8, x24, x8, x9
	str	x8, [sp, #336]                  ; 8-byte Folded Spill
	add	x8, x24, #12
	str	x8, [sp, #312]                  ; 8-byte Folded Spill
	stp	xzr, xzr, [sp, #368]
	stp	xzr, xzr, [x29, #-112]
	bl	_mach_absolute_time
	mov	x22, x0
	mov	x0, #0                          ; =0x0
	mov	w1, #65536                      ; =0x10000
	mov	w2, #3                          ; =0x3
	mov	w3, #4098                       ; =0x1002
	mov	w4, #-1                         ; =0xffffffff
	mov	x5, #0                          ; =0x0
	bl	_mmap
	cmn	x0, #1
	str	x22, [sp, #296]                 ; 8-byte Folded Spill
	str	x0, [sp, #360]                  ; 8-byte Folded Spill
	b.eq	LBB0_29
; %bb.27:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	x25, x0
	mov	w1, #65536                      ; =0x10000
	bl	_bzero
	mov	x0, x25
	ldp	x1, x2, [sp, #264]              ; 16-byte Folded Reload
	bl	_memcpy
	mov	x0, #0                          ; =0x0
	bl	_hv_vm_create
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_30
; %bb.28:                               ;   in Loop: Header=BB0_26 Depth=1
	str	wzr, [sp, #284]                 ; 4-byte Folded Spill
	str	wzr, [sp, #348]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #344]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh32:
	adrp	x22, l_.str.13@PAGE
Lloh33:
	add	x22, x22, l_.str.13@PAGEOFF
	b	LBB0_73
LBB0_29:                                ;   in Loop: Header=BB0_26 Depth=1
	bl	___error
	str	wzr, [sp, #284]                 ; 4-byte Folded Spill
	str	wzr, [sp, #348]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	ldrsw	x8, [x0]
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #344]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh34:
	adrp	x22, l_.str.12@PAGE
Lloh35:
	add	x22, x22, l_.str.12@PAGEOFF
	b	LBB0_73
LBB0_30:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x8, [sp, #256]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #256]                  ; 8-byte Folded Spill
	mov	x0, x25
	mov	w1, #1073741824                 ; =0x40000000
	mov	x2, x21
	mov	w3, #5                          ; =0x5
	bl	_hv_vm_map
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_32
; %bb.31:                               ;   in Loop: Header=BB0_26 Depth=1
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh36:
	adrp	x22, l_.str.14@PAGE
Lloh37:
	add	x22, x22, l_.str.14@PAGEOFF
	b	LBB0_73
LBB0_32:                                ;   in Loop: Header=BB0_26 Depth=1
	add	x0, x25, x21
	orr	x1, x21, #0x40000000
	ldr	x2, [sp, #224]                  ; 8-byte Folded Reload
	mov	w3, #3                          ; =0x3
	bl	_hv_vm_map
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_34
; %bb.33:                               ;   in Loop: Header=BB0_26 Depth=1
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh38:
	adrp	x22, l_.str.15@PAGE
Lloh39:
	add	x22, x22, l_.str.15@PAGEOFF
	b	LBB0_73
LBB0_34:                                ;   in Loop: Header=BB0_26 Depth=1
	add	x0, sp, #392
	add	x1, sp, #384
	mov	x2, #0                          ; =0x0
	bl	_hv_vcpu_create
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_36
; %bb.35:                               ;   in Loop: Header=BB0_26 Depth=1
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh40:
	adrp	x22, l_.str.16@PAGE
Lloh41:
	add	x22, x22, l_.str.16@PAGEOFF
	b	LBB0_73
LBB0_36:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x8, [sp, #216]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #216]                  ; 8-byte Folded Spill
	ldr	x0, [sp, #392]
	mov	w1, #31                         ; =0x1f
	mov	w2, #1073741824                 ; =0x40000000
	bl	_hv_vcpu_set_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_38
; %bb.37:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w25, #0                         ; =0x0
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
Lloh42:
	adrp	x22, l_.str.17@PAGE
Lloh43:
	add	x22, x22, l_.str.17@PAGEOFF
	b	LBB0_73
LBB0_38:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x0, [sp, #392]
	mov	w1, #34                         ; =0x22
	mov	w2, #965                        ; =0x3c5
	bl	_hv_vcpu_set_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_40
; %bb.39:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w25, #0                         ; =0x0
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
Lloh44:
	adrp	x22, l_.str.18@PAGE
Lloh45:
	add	x22, x22, l_.str.18@PAGEOFF
	b	LBB0_73
LBB0_40:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x0, [sp, #392]
	mov	w1, #57864                      ; =0xe208
	mov	w2, #1073807360                 ; =0x40010000
	bl	_hv_vcpu_set_sys_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_42
; %bb.41:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w25, #0                         ; =0x0
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
Lloh46:
	adrp	x22, l_.str.19@PAGE
Lloh47:
	add	x22, x22, l_.str.19@PAGEOFF
	b	LBB0_73
LBB0_42:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x0, [sp, #392]
	mov	w1, #0                          ; =0x0
	ldr	x2, [sp, #336]                  ; 8-byte Folded Reload
	bl	_hv_vcpu_set_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_44
; %bb.43:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w25, #0                         ; =0x0
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
Lloh48:
	adrp	x22, l_.str.20@PAGE
Lloh49:
	add	x22, x22, l_.str.20@PAGEOFF
	b	LBB0_73
LBB0_44:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x0, [sp, #392]
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
	mov	w1, #1                          ; =0x1
	mov	w2, #7                          ; =0x7
	bl	_hv_vcpu_set_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_46
; %bb.45:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w25, #0                         ; =0x0
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
Lloh50:
	adrp	x22, l_.str.21@PAGE
Lloh51:
	add	x22, x22, l_.str.21@PAGEOFF
	b	LBB0_73
LBB0_46:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x0, [sp, #392]
	bl	_hv_vcpu_run
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_48
; %bb.47:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w25, #0                         ; =0x0
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
Lloh52:
	adrp	x22, l_.str.22@PAGE
Lloh53:
	add	x22, x22, l_.str.22@PAGEOFF
	b	LBB0_73
LBB0_48:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x0, [sp, #392]
	add	x2, sp, #376
	mov	w1, #0                          ; =0x0
	bl	_hv_vcpu_get_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_50
; %bb.49:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w25, #0                         ; =0x0
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
Lloh54:
	adrp	x22, l_.str.23@PAGE
Lloh55:
	add	x22, x22, l_.str.23@PAGEOFF
	b	LBB0_73
LBB0_50:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x0, [sp, #392]
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
	add	x2, sp, #368
	mov	w1, #1                          ; =0x1
	bl	_hv_vcpu_get_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_52
; %bb.51:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w25, #0                         ; =0x0
	stp	xzr, xzr, [sp, #320]            ; 16-byte Folded Spill
	str	xzr, [sp, #288]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	stp	xzr, x8, [sp, #344]             ; 16-byte Folded Spill
Lloh56:
	adrp	x22, l_.str.24@PAGE
Lloh57:
	add	x22, x22, l_.str.24@PAGEOFF
	b	LBB0_73
LBB0_52:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x8, [sp, #384]
	ldr	w9, [x8]
	ldr	x8, [x8, #8]
	str	x8, [sp, #320]                  ; 8-byte Folded Spill
	str	x9, [sp, #352]                  ; 8-byte Folded Spill
	cmp	w9, #1
	b.ne	LBB0_58
; %bb.53:                               ;   in Loop: Header=BB0_26 Depth=1
	ldr	x8, [sp, #320]                  ; 8-byte Folded Reload
	and	x8, x8, #0xfffffffffc000000
	mov	w9, #1476395008                 ; =0x58000000
	cmp	x8, x9
	b.ne	LBB0_58
; %bb.54:                               ;   in Loop: Header=BB0_26 Depth=1
	ldr	x8, [sp, #376]
	ldr	x9, [sp, #312]                  ; 8-byte Folded Reload
	cmp	x8, x9
	b.ne	LBB0_58
; %bb.55:                               ;   in Loop: Header=BB0_26 Depth=1
	ldr	x8, [sp, #368]
	cbnz	x8, LBB0_58
; %bb.56:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w8, #1                          ; =0x1
	; InlineAsm Start
	isb
	; InlineAsm End
	bl	_mach_absolute_time
	str	x0, [sp, #304]                  ; 8-byte Folded Spill
	cmp	w21, #3856
	b.hs	LBB0_59
; %bb.57:                               ;   in Loop: Header=BB0_26 Depth=1
	str	xzr, [sp, #328]                 ; 8-byte Folded Spill
	str	xzr, [sp, #352]                 ; 8-byte Folded Spill
Lloh58:
	adrp	x22, l_.str.26@PAGE
Lloh59:
	add	x22, x22, l_.str.26@PAGEOFF
	b	LBB0_72
LBB0_58:                                ;   in Loop: Header=BB0_26 Depth=1
	str	xzr, [sp, #344]                 ; 8-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	xzr, [sp, #328]                 ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
Lloh60:
	adrp	x22, l_.str.25@PAGE
Lloh61:
	add	x22, x22, l_.str.25@PAGEOFF
	ldr	x8, [sp, #352]                  ; 8-byte Folded Reload
                                        ; kill: def $w8 killed $w8 killed $x8 def $x8
	str	x8, [sp, #288]                  ; 8-byte Folded Spill
	b	LBB0_73
LBB0_59:                                ;   in Loop: Header=BB0_26 Depth=1
	sub	x2, x29, #112
	ldr	x0, [sp, #360]                  ; 8-byte Folded Reload
	mov	w1, #65536                      ; =0x10000
	bl	_mincore
	cbz	w0, LBB0_61
; %bb.60:                               ;   in Loop: Header=BB0_26 Depth=1
	bl	___error
	str	xzr, [sp, #328]                 ; 8-byte Folded Spill
	ldrsw	x8, [x0]
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
Lloh62:
	adrp	x22, l_.str.27@PAGE
Lloh63:
	add	x22, x22, l_.str.27@PAGEOFF
	b	LBB0_72
LBB0_61:                                ;   in Loop: Header=BB0_26 Depth=1
	cmp	w21, #4, lsl #12                ; =16384
	b.ls	LBB0_63
; %bb.62:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	x8, #0                          ; =0x0
	str	xzr, [sp, #328]                 ; 8-byte Folded Spill
	b	LBB0_70
LBB0_63:                                ;   in Loop: Header=BB0_26 Depth=1
	cmp	w21, #1, lsl #12                ; =4096
	b.ls	LBB0_65
; %bb.64:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	x8, #0                          ; =0x0
	str	xzr, [sp, #328]                 ; 8-byte Folded Spill
	b	LBB0_67
LBB0_65:                                ;   in Loop: Header=BB0_26 Depth=1
	and	x8, x23, #0x1fff0
	ldur	q0, [x29, #-112]
	movi.16b	v1, #1
	and.16b	v0, v0, v1
	cmeq.16b	v0, v0, #0
	sshll2.8h	v1, v0, #0
	sshll2.4s	v2, v1, #0
	sshll2.2d	v3, v2, #0
	sshll.8h	v0, v0, #0
	sshll2.4s	v4, v0, #0
	sshll2.2d	v5, v4, #0
	sshll.4s	v0, v0, #0
	sshll2.2d	v6, v0, #0
	sshll.4s	v1, v1, #0
	sshll2.2d	v7, v1, #0
	sshll.2d	v4, v4, #0
	sshll.2d	v2, v2, #0
	sshll.2d	v0, v0, #0
	sshll.2d	v1, v1, #0
	ldr	q16, [sp, #192]                 ; 16-byte Folded Reload
	bic.16b	v1, v16, v1
	bic.16b	v0, v16, v0
	bic.16b	v2, v16, v2
	bic.16b	v4, v16, v4
	bic.16b	v7, v16, v7
	bic.16b	v6, v16, v6
	bic.16b	v5, v16, v5
	bic.16b	v3, v16, v3
	add.2d	v3, v5, v3
	add.2d	v5, v6, v7
	add.2d	v3, v5, v3
	add.2d	v2, v4, v2
	add.2d	v0, v0, v1
	add.2d	v0, v0, v2
	add.2d	v0, v0, v3
	addp.2d	d0, v0
	fmov	x9, d0
	str	x9, [sp, #328]                  ; 8-byte Folded Spill
	cmp	x23, x8
	b.eq	LBB0_71
; %bb.66:                               ;   in Loop: Header=BB0_26 Depth=1
	tst	x23, #0xc
	b.eq	LBB0_70
LBB0_67:                                ;   in Loop: Header=BB0_26 Depth=1
	mov	x9, x8
	and	x8, x23, #0x1fffc
	movi.2d	v0, #0000000000000000
	movi.2d	v1, #0000000000000000
	ldr	x10, [sp, #328]                 ; 8-byte Folded Reload
	mov.d	v1[0], x10
LBB0_68:                                ;   Parent Loop BB0_26 Depth=1
                                        ; =>  This Inner Loop Header: Depth=2
	sub	x10, x29, #112
	ldr	s2, [x10, x9]
	ushll.8h	v2, v2, #0
	bic.4h	v2, #254
	cmeq.4h	v2, v2, #0
	ushll.4s	v2, v2, #0
	ushll2.2d	v3, v2, #0
	shl.2d	v3, v3, #56
	sshr.2d	v3, v3, #56
	ushll.2d	v2, v2, #0
	shl.2d	v2, v2, #56
	sshr.2d	v2, v2, #56
	ldr	q4, [sp, #192]                  ; 16-byte Folded Reload
	bic.16b	v2, v4, v2
	bic.16b	v3, v4, v3
	add.2d	v0, v3, v0
	add.2d	v1, v2, v1
	add	x9, x9, #4
	cmp	x8, x9
	b.ne	LBB0_68
; %bb.69:                               ;   in Loop: Header=BB0_26 Depth=1
	add.2d	v0, v1, v0
	addp.2d	d0, v0
	fmov	x9, d0
	str	x9, [sp, #328]                  ; 8-byte Folded Spill
	cmp	x23, x8
	b.eq	LBB0_71
LBB0_70:                                ;   Parent Loop BB0_26 Depth=1
                                        ; =>  This Inner Loop Header: Depth=2
	sub	x9, x29, #112
	ldrb	w9, [x9, x8]
	tst	w9, #0x1
	csel	x9, xzr, x21, eq
	ldr	x10, [sp, #328]                 ; 8-byte Folded Reload
	add	x10, x9, x10
	str	x10, [sp, #328]                 ; 8-byte Folded Spill
	add	x8, x8, #1
	cmp	x8, x23
	b.lo	LBB0_70
LBB0_71:                                ;   in Loop: Header=BB0_26 Depth=1
	str	xzr, [sp, #352]                 ; 8-byte Folded Spill
	mov	x22, #0                         ; =0x0
LBB0_72:                                ;   in Loop: Header=BB0_26 Depth=1
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #284]                  ; 4-byte Folded Spill
	str	w8, [sp, #348]                  ; 4-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	x8, [sp, #288]                  ; 8-byte Folded Spill
	ldr	x8, [sp, #304]                  ; 8-byte Folded Reload
	cbnz	x8, LBB0_74
LBB0_73:                                ;   in Loop: Header=BB0_26 Depth=1
	bl	_mach_absolute_time
	str	x0, [sp, #304]                  ; 8-byte Folded Spill
LBB0_74:                                ;   in Loop: Header=BB0_26 Depth=1
	bl	_resident_now
	mov	x27, x0
	sub	x1, x29, #256
	mov	w0, #0                          ; =0x0
	bl	_getrusage
	ldur	x8, [x29, #-224]
	cmp	w0, #0
	csel	x28, x8, xzr, eq
	tbnz	w25, #0, LBB0_78
; %bb.75:                               ;   in Loop: Header=BB0_26 Depth=1
	ldr	x0, [sp, #392]
	bl	_hv_vcpu_destroy
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_77
; %bb.76:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w26, #0                         ; =0x0
	sxtw	x8, w0
	cmp	x22, #0
	ldr	x9, [sp, #352]                  ; 8-byte Folded Reload
	csel	x9, x8, x9, eq
	str	x9, [sp, #352]                  ; 8-byte Folded Spill
Lloh64:
	adrp	x8, l_.str.28@PAGE
Lloh65:
	add	x8, x8, l_.str.28@PAGEOFF
	csel	x22, x8, x22, eq
	b	LBB0_79
LBB0_77:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x8, [sp, #240]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #240]                  ; 8-byte Folded Spill
LBB0_78:                                ;   in Loop: Header=BB0_26 Depth=1
	mov	w26, #1                         ; =0x1
LBB0_79:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	w8, [sp, #344]                  ; 4-byte Folded Reload
	tbz	w8, #0, LBB0_81
; %bb.80:                               ;   in Loop: Header=BB0_26 Depth=1
	ldr	w9, [sp, #284]                  ; 4-byte Folded Reload
	b	LBB0_84
LBB0_81:                                ;   in Loop: Header=BB0_26 Depth=1
	bl	_hv_vm_destroy
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_83
; %bb.82:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w26, #0                         ; =0x0
	sxtw	x8, w0
	cmp	x22, #0
	ldr	x9, [sp, #352]                  ; 8-byte Folded Reload
	csel	x9, x8, x9, eq
	str	x9, [sp, #352]                  ; 8-byte Folded Spill
Lloh66:
	adrp	x8, l_.str.29@PAGE
Lloh67:
	add	x8, x8, l_.str.29@PAGEOFF
	csel	x22, x8, x22, eq
	ldr	w9, [sp, #284]                  ; 4-byte Folded Reload
	b	LBB0_84
LBB0_83:                                ;   in Loop: Header=BB0_26 Depth=1
	mov	w9, #0                          ; =0x0
	ldr	x8, [sp, #248]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #248]                  ; 8-byte Folded Spill
LBB0_84:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x8, [sp, #360]                  ; 8-byte Folded Reload
	cmn	x8, #1
	b.eq	LBB0_91
; %bb.85:                               ;   in Loop: Header=BB0_26 Depth=1
	cbnz	w9, LBB0_91
; %bb.86:                               ;   in Loop: Header=BB0_26 Depth=1
	ldr	x0, [sp, #360]                  ; 8-byte Folded Reload
	mov	w1, #65536                      ; =0x10000
	bl	_munmap
	cbz	w0, LBB0_89
; %bb.87:                               ;   in Loop: Header=BB0_26 Depth=1
	cbz	x22, LBB0_90
; %bb.88:                               ;   in Loop: Header=BB0_26 Depth=1
	mov	w26, #0                         ; =0x0
	b	LBB0_91
LBB0_89:                                ;   in Loop: Header=BB0_26 Depth=1
	ldr	x8, [sp, #232]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #232]                  ; 8-byte Folded Spill
	b	LBB0_91
LBB0_90:                                ;   in Loop: Header=BB0_26 Depth=1
	bl	___error
	mov	w26, #0                         ; =0x0
	ldrsw	x8, [x0]
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
Lloh68:
	adrp	x22, l_.str.30@PAGE
Lloh69:
	add	x22, x22, l_.str.30@PAGEOFF
LBB0_91:                                ;   in Loop: Header=BB0_26 Depth=1
	bl	_getpid
                                        ; kill: def $w0 killed $w0 def $x0
	ldp	x17, x1, [sp, #296]             ; 16-byte Folded Reload
	sub	x8, x1, x17
	ucvtf	d0, x8
	ldp	s1, s2, [x20]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ldp	x10, x9, [sp, #368]
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	ldr	w11, [sp, #348]                 ; 4-byte Folded Reload
	cmp	w11, #0
Lloh70:
	adrp	x14, l_.str.33@PAGE
Lloh71:
	add	x14, x14, l_.str.33@PAGEOFF
Lloh72:
	adrp	x15, l_.str.32@PAGE
Lloh73:
	add	x15, x15, l_.str.32@PAGEOFF
	csel	x11, x15, x14, ne
	ldr	w12, [sp, #344]                 ; 4-byte Folded Reload
	cmp	w12, #0
	csel	x12, x14, x15, ne
	cmp	w25, #0
	csel	x13, x14, x15, ne
	cmp	w26, #0
	csel	x14, x15, x14, ne
	ldr	x15, [sp, #360]                 ; 8-byte Folded Reload
	cmn	x15, #1
	mov	w16, #65536                     ; =0x10000
	csel	x15, xzr, x16, eq
	stp	x27, x28, [sp, #176]
	str	x16, [sp, #168]
	ldr	x16, [sp, #328]                 ; 8-byte Folded Reload
	stp	x15, x16, [sp, #152]
	ldr	x15, [sp, #272]                 ; 8-byte Folded Reload
	stp	x14, x15, [sp, #136]
	stp	x12, x13, [sp, #120]
	str	x11, [sp, #112]
	stp	x1, x8, [sp, #88]
	ldr	x8, [sp, #320]                  ; 8-byte Folded Reload
	stp	x8, x17, [sp, #72]
	ldr	x8, [sp, #288]                  ; 8-byte Folded Reload
	stp	x10, x8, [sp, #56]
	ldr	x8, [sp, #312]                  ; 8-byte Folded Reload
	stp	x8, x9, [sp, #40]
	mov	w8, #7                          ; =0x7
	str	x8, [sp, #32]
	ldr	x8, [sp, #336]                  ; 8-byte Folded Reload
	stp	x24, x8, [sp, #16]
	stp	x24, x0, [sp]
	str	d0, [sp, #104]
Lloh74:
	adrp	x0, l_.str.31@PAGE
Lloh75:
	add	x0, x0, l_.str.31@PAGEOFF
	bl	_printf
	cbz	x22, LBB0_93
; %bb.92:                               ;   in Loop: Header=BB0_26 Depth=1
	str	x22, [sp]
Lloh76:
	adrp	x0, l_.str.34@PAGE
Lloh77:
	add	x0, x0, l_.str.34@PAGEOFF
	b	LBB0_94
LBB0_93:                                ;   in Loop: Header=BB0_26 Depth=1
Lloh78:
	adrp	x0, l_.str.35@PAGE
Lloh79:
	add	x0, x0, l_.str.35@PAGEOFF
LBB0_94:                                ;   in Loop: Header=BB0_26 Depth=1
	bl	_printf
	ldr	x8, [sp, #352]                  ; 8-byte Folded Reload
	str	x8, [sp]
Lloh80:
	adrp	x0, l_.str.36@PAGE
Lloh81:
	add	x0, x0, l_.str.36@PAGEOFF
	bl	_printf
Lloh82:
	adrp	x8, ___stdoutp@GOTPAGE
Lloh83:
	ldr	x8, [x8, ___stdoutp@GOTPAGEOFF]
Lloh84:
	ldr	x0, [x8]
	bl	_fflush
	cmp	x22, #0
	csel	w8, wzr, w26, ne
	ldr	w9, [sp, #348]                  ; 4-byte Folded Reload
	and	w8, w9, w8
	cmp	w8, #1
	b.ne	LBB0_102
; %bb.95:                               ;   in Loop: Header=BB0_26 Depth=1
	add	x24, x24, #1
	cmp	x24, x19
	b.ne	LBB0_26
; %bb.96:
	ldp	x9, x8, [sp, #232]              ; 16-byte Folded Reload
	stp	x8, x9, [sp, #32]
	ldr	x9, [sp, #216]                  ; 8-byte Folded Reload
	ldp	x10, x8, [sp, #248]             ; 16-byte Folded Reload
	stp	x10, x9, [sp, #16]
	stp	x19, x8, [sp]
Lloh85:
	adrp	x0, l_.str.37@PAGE
Lloh86:
	add	x0, x0, l_.str.37@PAGEOFF
	bl	_printf
Lloh87:
	adrp	x8, ___stdoutp@GOTPAGE
Lloh88:
	ldr	x8, [x8, ___stdoutp@GOTPAGEOFF]
Lloh89:
	ldr	x0, [x8]
	bl	_fflush
	ldr	x0, [sp, #264]                  ; 8-byte Folded Reload
	bl	_free
	mov	w0, #0                          ; =0x0
	b	LBB0_8
LBB0_97:
Lloh90:
	adrp	x0, l_.str.7@PAGE
Lloh91:
	add	x0, x0, l_.str.7@PAGEOFF
	mov	x1, x27
	b	LBB0_101
LBB0_98:
	bl	___error
	ldrsw	x1, [x0]
Lloh92:
	adrp	x0, l_.str.8@PAGE
Lloh93:
	add	x0, x0, l_.str.8@PAGEOFF
	b	LBB0_101
LBB0_99:
	bl	___error
	ldrsw	x1, [x0]
Lloh94:
	adrp	x0, l_.str.9@PAGE
Lloh95:
	add	x0, x0, l_.str.9@PAGEOFF
	b	LBB0_101
LBB0_100:
	sxtw	x1, w0
Lloh96:
	adrp	x0, l_.str.10@PAGE
Lloh97:
	add	x0, x0, l_.str.10@PAGEOFF
LBB0_101:
	bl	_fail_ready
	b	LBB0_7
LBB0_102:
	ldr	x0, [sp, #264]                  ; 8-byte Folded Reload
	bl	_free
	mov	w0, #3                          ; =0x3
	b	LBB0_8
LBB0_103:
	bl	___stack_chk_fail
	.loh AdrpLdrGotLdr	Lloh0, Lloh1, Lloh2
	.loh AdrpAdd	Lloh3, Lloh4
	.loh AdrpAdd	Lloh5, Lloh6
	.loh AdrpLdrGotLdr	Lloh9, Lloh10, Lloh11
	.loh AdrpAdd	Lloh7, Lloh8
	.loh AdrpLdrGotLdr	Lloh12, Lloh13, Lloh14
	.loh AdrpAdd	Lloh15, Lloh16
	.loh AdrpAdd	Lloh17, Lloh18
	.loh AdrpAdd	Lloh19, Lloh20
	.loh AdrpAdd	Lloh21, Lloh22
	.loh AdrpAdd	Lloh23, Lloh24
	.loh AdrpAdd	Lloh25, Lloh26
	.loh AdrpLdrGotLdr	Lloh29, Lloh30, Lloh31
	.loh AdrpAdd	Lloh27, Lloh28
	.loh AdrpAdd	Lloh32, Lloh33
	.loh AdrpAdd	Lloh34, Lloh35
	.loh AdrpAdd	Lloh36, Lloh37
	.loh AdrpAdd	Lloh38, Lloh39
	.loh AdrpAdd	Lloh40, Lloh41
	.loh AdrpAdd	Lloh42, Lloh43
	.loh AdrpAdd	Lloh44, Lloh45
	.loh AdrpAdd	Lloh46, Lloh47
	.loh AdrpAdd	Lloh48, Lloh49
	.loh AdrpAdd	Lloh50, Lloh51
	.loh AdrpAdd	Lloh52, Lloh53
	.loh AdrpAdd	Lloh54, Lloh55
	.loh AdrpAdd	Lloh56, Lloh57
	.loh AdrpAdd	Lloh58, Lloh59
	.loh AdrpAdd	Lloh60, Lloh61
	.loh AdrpAdd	Lloh62, Lloh63
	.loh AdrpAdd	Lloh64, Lloh65
	.loh AdrpAdd	Lloh66, Lloh67
	.loh AdrpAdd	Lloh68, Lloh69
	.loh AdrpAdd	Lloh74, Lloh75
	.loh AdrpAdd	Lloh72, Lloh73
	.loh AdrpAdd	Lloh70, Lloh71
	.loh AdrpAdd	Lloh76, Lloh77
	.loh AdrpAdd	Lloh78, Lloh79
	.loh AdrpLdrGotLdr	Lloh82, Lloh83, Lloh84
	.loh AdrpAdd	Lloh80, Lloh81
	.loh AdrpLdrGotLdr	Lloh87, Lloh88, Lloh89
	.loh AdrpAdd	Lloh85, Lloh86
	.loh AdrpAdd	Lloh90, Lloh91
	.loh AdrpAdd	Lloh92, Lloh93
	.loh AdrpAdd	Lloh94, Lloh95
	.loh AdrpAdd	Lloh96, Lloh97
	.cfi_endproc
                                        ; -- End function
	.p2align	2                               ; -- Begin function fail_ready
_fail_ready:                            ; @fail_ready
	.cfi_startproc
; %bb.0:
	sub	sp, sp, #32
	stp	x29, x30, [sp, #16]             ; 16-byte Folded Spill
	add	x29, sp, #16
	.cfi_def_cfa w29, 16
	.cfi_offset w30, -8
	.cfi_offset w29, -16
	stp	x0, x1, [sp]
Lloh98:
	adrp	x0, l_.str.38@PAGE
Lloh99:
	add	x0, x0, l_.str.38@PAGEOFF
	bl	_printf
Lloh100:
	adrp	x8, ___stdoutp@GOTPAGE
Lloh101:
	ldr	x8, [x8, ___stdoutp@GOTPAGEOFF]
Lloh102:
	ldr	x0, [x8]
	ldp	x29, x30, [sp, #16]             ; 16-byte Folded Reload
	add	sp, sp, #32
	b	_fflush
	.loh AdrpLdrGotLdr	Lloh100, Lloh101, Lloh102
	.loh AdrpAdd	Lloh98, Lloh99
	.cfi_endproc
                                        ; -- End function
	.p2align	2                               ; -- Begin function resident_now
_resident_now:                          ; @resident_now
	.cfi_startproc
; %bb.0:
	sub	sp, sp, #80
	stp	x29, x30, [sp, #64]             ; 16-byte Folded Spill
	add	x29, sp, #64
	.cfi_def_cfa w29, 16
	.cfi_offset w30, -8
	.cfi_offset w29, -16
	mov	w8, #12                         ; =0xc
	str	w8, [sp, #12]
Lloh103:
	adrp	x8, _mach_task_self_@GOTPAGE
Lloh104:
	ldr	x8, [x8, _mach_task_self_@GOTPAGEOFF]
Lloh105:
	ldr	w0, [x8]
	add	x2, sp, #16
	add	x3, sp, #12
	mov	w1, #20                         ; =0x14
	bl	_task_info
	ldr	x8, [sp, #24]
	cmp	w0, #0
	csel	x0, x8, xzr, eq
	ldp	x29, x30, [sp, #64]             ; 16-byte Folded Reload
	add	sp, sp, #80
	ret
	.loh AdrpLdrGotLdr	Lloh103, Lloh104, Lloh105
	.cfi_endproc
                                        ; -- End function
	.section	__TEXT,__cstring,cstring_literals
l_.str:                                 ; @.str
	.asciz	"usage: guest-campaign image.bin trials"

l_.str.1:                               ; @.str.1
	.asciz	"invalid trial count"

.zerofill __DATA,__bss,_timebase,8,2    ; @timebase
l_.str.2:                               ; @.str.2
	.asciz	"timebase"

l_.str.3:                               ; @.str.3
	.asciz	"unsupported page size"

l_.str.4:                               ; @.str.4
	.asciz	"rb"

l_.str.5:                               ; @.str.5
	.asciz	"admitted image open"

l_.str.6:                               ; @.str.6
	.asciz	"image seek"

l_.str.7:                               ; @.str.7
	.asciz	"admitted image size"

l_.str.8:                               ; @.str.8
	.asciz	"admitted image allocation"

l_.str.9:                               ; @.str.9
	.asciz	"admitted image read"

l_.str.10:                              ; @.str.10
	.asciz	"hypervisor capacity query"

l_.str.11:                              ; @.str.11
	.asciz	"{\"kind\":\"controller_ready\",\"format\":\"aether.fresh-guest-controller/1\",\"pid\":%d,\"requestedTrials\":%ld,\"timebaseNumer\":%u,\"timebaseDenom\":%u,\"pageBytes\":%zu,\"imageBytes\":%ld,\"maximumVcpus\":%u,\"createdVmsBeforeCampaign\":0,\"createdVcpusBeforeCampaign\":0,\"guestBytesBeforeCampaign\":0,\"controllerInitializationNs\":%.3f,\"controllerCurrentRssBytes\":%llu,\"controllerPeakRssBytes\":%llu}\n"

l_.str.12:                              ; @.str.12
	.asciz	"fresh guest mmap"

l_.str.13:                              ; @.str.13
	.asciz	"fresh hv_vm_create"

l_.str.14:                              ; @.str.14
	.asciz	"map fresh RX code"

l_.str.15:                              ; @.str.15
	.asciz	"map fresh RW stack/data"

l_.str.16:                              ; @.str.16
	.asciz	"fresh hv_vcpu_create"

l_.str.17:                              ; @.str.17
	.asciz	"set entry"

l_.str.18:                              ; @.str.18
	.asciz	"set EL1h"

l_.str.19:                              ; @.str.19
	.asciz	"set fresh stack"

l_.str.20:                              ; @.str.20
	.asciz	"set gross"

l_.str.21:                              ; @.str.21
	.asciz	"set adjustment"

l_.str.22:                              ; @.str.22
	.asciz	"run fresh guest"

l_.str.23:                              ; @.str.23
	.asciz	"read value"

l_.str.24:                              ; @.str.24
	.asciz	"read status"

l_.str.25:                              ; @.str.25
	.asciz	"response validation"

l_.str.26:                              ; @.str.26
	.asciz	"residency vector bounds"

l_.str.27:                              ; @.str.27
	.asciz	"guest residency observation"

l_.str.28:                              ; @.str.28
	.asciz	"destroy vCPU"

l_.str.29:                              ; @.str.29
	.asciz	"destroy VM"

l_.str.30:                              ; @.str.30
	.asciz	"unmap guest memory"

l_.str.31:                              ; @.str.31
	.asciz	"{\"kind\":\"guest_sample\",\"trial\":%ld,\"guestId\":\"%d:%ld\",\"gross\":\"%llu\",\"adjustment\":\"%llu\",\"expected\":\"%llu\",\"actual\":\"%llu\",\"status\":\"%llu\",\"exceptionReason\":%u,\"syndrome\":\"%llu\",\"startTick\":\"%llu\",\"validatedResponseTick\":\"%llu\",\"durationTicks\":\"%llu\",\"freshGuestToValidatedResponseNs\":%.3f,\"responseValidated\":%s,\"freshVmCreated\":%s,\"freshVcpuCreated\":%s,\"cleanupSucceeded\":%s,\"guestImageBytes\":%ld,\"guestMappedBytes\":%zu,\"guestResidentObservedBytes\":%zu,\"guestResidentPeakUpperBoundBytes\":%zu,\"controllerCurrentRssBytes\":%llu,\"controllerPeakRssBytes\":%llu,\"errorStage\":"

l_.str.32:                              ; @.str.32
	.asciz	"true"

l_.str.33:                              ; @.str.33
	.asciz	"false"

l_.str.34:                              ; @.str.34
	.asciz	"\"%s\""

l_.str.35:                              ; @.str.35
	.asciz	"null"

l_.str.36:                              ; @.str.36
	.asciz	",\"errorCode\":\"%lld\"}\n"

l_.str.37:                              ; @.str.37
	.asciz	"{\"kind\":\"campaign_complete\",\"completedTrials\":%ld,\"createdVms\":%llu,\"destroyedVms\":%llu,\"createdVcpus\":%llu,\"destroyedVcpus\":%llu,\"unmappedGuests\":%llu}\n"

l_.str.38:                              ; @.str.38
	.asciz	"{\"kind\":\"controller_error\",\"stage\":\"%s\",\"code\":\"%lld\"}\n"

.subsections_via_symbols
