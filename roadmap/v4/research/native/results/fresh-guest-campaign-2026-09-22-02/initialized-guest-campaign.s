	.build_version macos, 26, 0	sdk_version 27, 0
	.section	__TEXT,__text,regular,pure_instructions
	.globl	_main                           ; -- Begin function main
	.p2align	2
_main:                                  ; @main
	.cfi_startproc
; %bb.0:
	stp	d9, d8, [sp, #-112]!            ; 16-byte Folded Spill
	stp	x28, x27, [sp, #16]             ; 16-byte Folded Spill
	stp	x26, x25, [sp, #32]             ; 16-byte Folded Spill
	stp	x24, x23, [sp, #48]             ; 16-byte Folded Spill
	stp	x22, x21, [sp, #64]             ; 16-byte Folded Spill
	stp	x20, x19, [sp, #80]             ; 16-byte Folded Spill
	stp	x29, x30, [sp, #96]             ; 16-byte Folded Spill
	add	x29, sp, #96
	sub	sp, sp, #608
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
	.cfi_offset b8, -104
	.cfi_offset b9, -112
Lloh0:
	adrp	x8, ___stack_chk_guard@GOTPAGE
Lloh1:
	ldr	x8, [x8, ___stack_chk_guard@GOTPAGEOFF]
Lloh2:
	ldr	x8, [x8]
	stur	x8, [x29, #-112]
	cmp	w0, #3
	b.ne	LBB0_4
; %bb.1:
	mov	x22, x1
	str	xzr, [sp, #424]
	bl	___error
	str	wzr, [x0]
	ldr	x0, [x22, #16]
	add	x1, sp, #424
	mov	w2, #10                         ; =0xa
	bl	_strtol
	mov	x19, x0
	bl	___error
	ldr	w9, [x0]
	ldr	x8, [sp, #424]
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
	adrp	x0, l_.str.42@PAGE
Lloh8:
	add	x0, x0, l_.str.42@PAGEOFF
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
	ldur	x8, [x29, #-112]
Lloh12:
	adrp	x9, ___stack_chk_guard@GOTPAGE
Lloh13:
	ldr	x9, [x9, ___stack_chk_guard@GOTPAGEOFF]
Lloh14:
	ldr	x9, [x9]
	cmp	x9, x8
	b.ne	LBB0_110
; %bb.9:
	add	sp, sp, #608
	ldp	x29, x30, [sp, #96]             ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #80]             ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #64]             ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #48]             ; 16-byte Folded Reload
	ldp	x26, x25, [sp, #32]             ; 16-byte Folded Reload
	ldp	x28, x27, [sp, #16]             ; 16-byte Folded Reload
	ldp	d9, d8, [sp], #112              ; 16-byte Folded Reload
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
	udiv	x28, x8, x21
	smsubl	x8, w28, w0, x8
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
	b	LBB0_31
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
	b	LBB0_31
LBB0_19:
	mov	x0, x25
	bl	_ftell
	mov	x22, x0
	mov	x0, x25
	bl	_rewind
	cmp	x22, #1
	b.lt	LBB0_27
; %bb.20:
	cmp	x22, x21
	b.hi	LBB0_27
; %bb.21:
	mov	x0, x22
	bl	_malloc
	cbz	x0, LBB0_28
; %bb.22:
	mov	x23, x0
	mov	w1, #1                          ; =0x1
	mov	x2, x22
	mov	x3, x25
	bl	_fread
	cmp	x0, x22
	b.ne	LBB0_29
; %bb.23:
	mov	x0, x25
	bl	_fclose
	str	wzr, [sp, #420]
	add	x0, sp, #420
	bl	_hv_vm_get_max_vcpu_count
                                        ; kill: def $w0 killed $w0 def $x0
	cbnz	w0, LBB0_30
; %bb.24:
	ldr	w8, [sp, #420]
	cbz	w8, LBB0_30
; %bb.25:
	bl	_mach_absolute_time
	mov	x25, x0
	mov	x0, #0                          ; =0x0
	bl	_hv_vm_create
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_32
; %bb.26:
	sxtw	x1, w0
Lloh27:
	adrp	x0, l_.str.11@PAGE
Lloh28:
	add	x0, x0, l_.str.11@PAGEOFF
	b	LBB0_31
LBB0_27:
Lloh29:
	adrp	x0, l_.str.7@PAGE
Lloh30:
	add	x0, x0, l_.str.7@PAGEOFF
	mov	x1, x22
	b	LBB0_31
LBB0_28:
	bl	___error
	ldrsw	x1, [x0]
Lloh31:
	adrp	x0, l_.str.8@PAGE
Lloh32:
	add	x0, x0, l_.str.8@PAGEOFF
	b	LBB0_31
LBB0_29:
	bl	___error
	ldrsw	x1, [x0]
Lloh33:
	adrp	x0, l_.str.9@PAGE
Lloh34:
	add	x0, x0, l_.str.9@PAGEOFF
	b	LBB0_31
LBB0_30:
	sxtw	x1, w0
Lloh35:
	adrp	x0, l_.str.10@PAGE
Lloh36:
	add	x0, x0, l_.str.10@PAGEOFF
LBB0_31:
	bl	_fail_ready
	b	LBB0_7
LBB0_32:
	stp	xzr, xzr, [sp, #400]
	add	x0, sp, #408
	add	x1, sp, #400
	mov	x2, #0                          ; =0x0
	bl	_hv_vcpu_create
	cbz	w0, LBB0_34
; %bb.33:
	mov	x26, x0
	bl	_hv_vm_destroy
	sxtw	x1, w26
Lloh37:
	adrp	x0, l_.str.12@PAGE
Lloh38:
	add	x0, x0, l_.str.12@PAGEOFF
	b	LBB0_31
LBB0_34:
	ldr	x0, [sp, #408]
	bl	_hv_vcpu_destroy
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_36
; %bb.35:
	sxtw	x1, w0
Lloh39:
	adrp	x0, l_.str.13@PAGE
Lloh40:
	add	x0, x0, l_.str.13@PAGEOFF
	b	LBB0_31
LBB0_36:
	bl	_hv_vm_destroy
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_38
; %bb.37:
	sxtw	x1, w0
Lloh41:
	adrp	x0, l_.str.14@PAGE
Lloh42:
	add	x0, x0, l_.str.14@PAGEOFF
	b	LBB0_31
LBB0_38:
	bl	_mach_absolute_time
	str	x0, [sp, #336]                  ; 8-byte Folded Spill
	bl	_resident_now
	str	x0, [sp, #360]                  ; 8-byte Folded Spill
	add	x1, sp, #432
	mov	w0, #0                          ; =0x0
	bl	_getrusage
	ldr	x8, [sp, #464]
	cmp	w0, #0
	csel	x8, x8, xzr, eq
	str	x8, [sp, #344]                  ; 8-byte Folded Spill
	bl	_getpid
                                        ; kill: def $w0 killed $w0 def $x0
	str	x0, [sp, #352]                  ; 8-byte Folded Spill
	ldp	w27, w26, [x20]
	ldr	x8, [sp, #336]                  ; 8-byte Folded Reload
	sub	x8, x8, x25
	ucvtf	d0, x8
	ucvtf	d1, w27
	fmul	d0, d0, d1
	ucvtf	d1, w26
	fdiv	d8, d0, d1
	ldr	w25, [sp, #420]
	bl	_mach_absolute_time
	sub	x8, x0, x24
	ucvtf	d0, x8
	ldp	s1, s2, [x20]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	ldr	x9, [sp, #344]                  ; 8-byte Folded Reload
	ldp	x8, x10, [sp, #352]             ; 16-byte Folded Reload
	stp	x10, x9, [sp, #72]
	stp	x22, x25, [sp, #40]
	stp	x26, x21, [sp, #24]
	stp	x19, x27, [sp, #8]
	str	x8, [sp]
Lloh43:
	adrp	x0, l_.str.15@PAGE
Lloh44:
	add	x0, x0, l_.str.15@PAGEOFF
	stp	d8, d0, [sp, #56]
	bl	_printf
Lloh45:
	adrp	x8, ___stdoutp@GOTPAGE
Lloh46:
	ldr	x8, [x8, ___stdoutp@GOTPAGEOFF]
Lloh47:
	ldr	x0, [x8]
	bl	_fflush
	stp	xzr, xzr, [sp, #240]            ; 16-byte Folded Spill
	stp	xzr, xzr, [sp, #224]            ; 16-byte Folded Spill
	mov	x26, #0                         ; =0x0
	mov	w8, #65536                      ; =0x10000
	sub	x8, x8, x21
	stp	xzr, x8, [sp, #208]             ; 16-byte Folded Spill
	dup.2d	v0, x21
	str	q0, [sp, #192]                  ; 16-byte Folded Spill
LBB0_39:                                ; =>This Loop Header: Depth=1
                                        ;     Child Loop BB0_81 Depth 2
                                        ;     Child Loop BB0_83 Depth 2
	stp	xzr, xzr, [sp, #384]
	mov	w8, #200                        ; =0xc8
	mov	x9, #1000                       ; =0x3e8
	madd	x8, x26, x8, x9
	str	x8, [sp, #328]                  ; 8-byte Folded Spill
	add	x8, x26, #12
	str	x8, [sp, #304]                  ; 8-byte Folded Spill
	stp	xzr, xzr, [sp, #368]
	stp	xzr, xzr, [x29, #-128]
	bl	_mach_absolute_time
	mov	x24, x0
	mov	x0, #0                          ; =0x0
	mov	w1, #65536                      ; =0x10000
	mov	w2, #3                          ; =0x3
	mov	w3, #4098                       ; =0x1002
	mov	w4, #-1                         ; =0xffffffff
	mov	x5, #0                          ; =0x0
	bl	_mmap
	str	x0, [sp, #360]                  ; 8-byte Folded Spill
	cmn	x0, #1
	str	x24, [sp, #288]                 ; 8-byte Folded Spill
	str	x26, [sp, #272]                 ; 8-byte Folded Spill
	b.eq	LBB0_42
; %bb.40:                               ;   in Loop: Header=BB0_39 Depth=1
	ldr	x24, [sp, #360]                 ; 8-byte Folded Reload
	mov	x0, x24
	mov	w1, #65536                      ; =0x10000
	bl	_bzero
	mov	x0, x24
	mov	x1, x23
	mov	x2, x22
	bl	_memcpy
	mov	x0, #0                          ; =0x0
	bl	_hv_vm_create
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_43
; %bb.41:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #260]                 ; 4-byte Folded Spill
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #336]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh48:
	adrp	x24, l_.str.17@PAGE
Lloh49:
	add	x24, x24, l_.str.17@PAGEOFF
	b	LBB0_86
LBB0_42:                                ;   in Loop: Header=BB0_39 Depth=1
	bl	___error
	str	wzr, [sp, #260]                 ; 4-byte Folded Spill
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	ldrsw	x8, [x0]
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #336]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh50:
	adrp	x24, l_.str.16@PAGE
Lloh51:
	add	x24, x24, l_.str.16@PAGEOFF
	b	LBB0_86
LBB0_43:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #248]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #248]                  ; 8-byte Folded Spill
	ldr	x0, [sp, #360]                  ; 8-byte Folded Reload
	mov	w1, #1073741824                 ; =0x40000000
	mov	x2, x21
	mov	w3, #5                          ; =0x5
	bl	_hv_vm_map
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_45
; %bb.44:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh52:
	adrp	x24, l_.str.18@PAGE
Lloh53:
	add	x24, x24, l_.str.18@PAGEOFF
	b	LBB0_86
LBB0_45:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #360]                  ; 8-byte Folded Reload
	add	x0, x8, x21
	orr	x1, x21, #0x40000000
	ldr	x2, [sp, #216]                  ; 8-byte Folded Reload
	mov	w3, #3                          ; =0x3
	bl	_hv_vm_map
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_47
; %bb.46:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh54:
	adrp	x24, l_.str.19@PAGE
Lloh55:
	add	x24, x24, l_.str.19@PAGEOFF
	b	LBB0_86
LBB0_47:                                ;   in Loop: Header=BB0_39 Depth=1
	add	x0, sp, #392
	add	x1, sp, #384
	mov	x2, #0                          ; =0x0
	bl	_hv_vcpu_create
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_49
; %bb.48:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
	mov	w25, #1                         ; =0x1
Lloh56:
	adrp	x24, l_.str.20@PAGE
Lloh57:
	add	x24, x24, l_.str.20@PAGEOFF
	b	LBB0_86
LBB0_49:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #208]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #208]                  ; 8-byte Folded Spill
	ldr	x0, [sp, #392]
	mov	w1, #31                         ; =0x1f
	mov	w2, #1073741824                 ; =0x40000000
	bl	_hv_vcpu_set_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_51
; %bb.50:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
Lloh58:
	adrp	x24, l_.str.21@PAGE
Lloh59:
	add	x24, x24, l_.str.21@PAGEOFF
	b	LBB0_86
LBB0_51:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x0, [sp, #392]
	mov	w1, #34                         ; =0x22
	mov	w2, #965                        ; =0x3c5
	bl	_hv_vcpu_set_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_53
; %bb.52:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
Lloh60:
	adrp	x24, l_.str.22@PAGE
Lloh61:
	add	x24, x24, l_.str.22@PAGEOFF
	b	LBB0_86
LBB0_53:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x0, [sp, #392]
	mov	w1, #57864                      ; =0xe208
	mov	w2, #1073807360                 ; =0x40010000
	bl	_hv_vcpu_set_sys_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_55
; %bb.54:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
Lloh62:
	adrp	x24, l_.str.23@PAGE
Lloh63:
	add	x24, x24, l_.str.23@PAGEOFF
	b	LBB0_86
LBB0_55:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x0, [sp, #392]
	mov	w1, #0                          ; =0x0
	ldr	x2, [sp, #328]                  ; 8-byte Folded Reload
	bl	_hv_vcpu_set_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_57
; %bb.56:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
Lloh64:
	adrp	x24, l_.str.24@PAGE
Lloh65:
	add	x24, x24, l_.str.24@PAGEOFF
	b	LBB0_86
LBB0_57:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x0, [sp, #392]
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
	mov	w1, #1                          ; =0x1
	mov	w2, #7                          ; =0x7
	bl	_hv_vcpu_set_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_59
; %bb.58:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
Lloh66:
	adrp	x24, l_.str.25@PAGE
Lloh67:
	add	x24, x24, l_.str.25@PAGEOFF
	b	LBB0_86
LBB0_59:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x0, [sp, #392]
	bl	_hv_vcpu_run
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_61
; %bb.60:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
Lloh68:
	adrp	x24, l_.str.26@PAGE
Lloh69:
	add	x24, x24, l_.str.26@PAGEOFF
	b	LBB0_86
LBB0_61:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x0, [sp, #392]
	add	x2, sp, #376
	mov	w1, #0                          ; =0x0
	bl	_hv_vcpu_get_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_63
; %bb.62:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
Lloh70:
	adrp	x24, l_.str.27@PAGE
Lloh71:
	add	x24, x24, l_.str.27@PAGEOFF
	b	LBB0_86
LBB0_63:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x0, [sp, #392]
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
	add	x2, sp, #368
	mov	w1, #1                          ; =0x1
	bl	_hv_vcpu_get_reg
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_65
; %bb.64:                               ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	stp	xzr, xzr, [sp, #312]            ; 16-byte Folded Spill
	str	xzr, [sp, #280]                 ; 8-byte Folded Spill
	sxtw	x8, w0
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
Lloh72:
	adrp	x24, l_.str.28@PAGE
Lloh73:
	add	x24, x24, l_.str.28@PAGEOFF
	b	LBB0_86
LBB0_65:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #384]
	ldr	w9, [x8]
	ldr	x8, [x8, #8]
	str	x8, [sp, #312]                  ; 8-byte Folded Spill
	str	x9, [sp, #352]                  ; 8-byte Folded Spill
	cmp	w9, #1
	b.ne	LBB0_71
; %bb.66:                               ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #312]                  ; 8-byte Folded Reload
	and	x8, x8, #0xfffffffffc000000
	mov	w9, #1476395008                 ; =0x58000000
	cmp	x8, x9
	b.ne	LBB0_71
; %bb.67:                               ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #376]
	ldr	x9, [sp, #304]                  ; 8-byte Folded Reload
	cmp	x8, x9
	b.ne	LBB0_71
; %bb.68:                               ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #368]
	cbnz	x8, LBB0_71
; %bb.69:                               ;   in Loop: Header=BB0_39 Depth=1
	mov	w8, #1                          ; =0x1
	; InlineAsm Start
	isb
	; InlineAsm End
	bl	_mach_absolute_time
	str	x0, [sp, #296]                  ; 8-byte Folded Spill
	cmp	w21, #3856
	b.hs	LBB0_72
; %bb.70:                               ;   in Loop: Header=BB0_39 Depth=1
	str	xzr, [sp, #320]                 ; 8-byte Folded Spill
	str	xzr, [sp, #352]                 ; 8-byte Folded Spill
Lloh74:
	adrp	x24, l_.str.30@PAGE
Lloh75:
	add	x24, x24, l_.str.30@PAGEOFF
	b	LBB0_85
LBB0_71:                                ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	str	wzr, [sp, #344]                 ; 4-byte Folded Spill
	str	xzr, [sp, #320]                 ; 8-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
Lloh76:
	adrp	x24, l_.str.29@PAGE
Lloh77:
	add	x24, x24, l_.str.29@PAGEOFF
	ldr	x8, [sp, #352]                  ; 8-byte Folded Reload
                                        ; kill: def $w8 killed $w8 killed $x8 def $x8
	str	x8, [sp, #280]                  ; 8-byte Folded Spill
	b	LBB0_86
LBB0_72:                                ;   in Loop: Header=BB0_39 Depth=1
	sub	x2, x29, #128
	ldr	x0, [sp, #360]                  ; 8-byte Folded Reload
	mov	w1, #65536                      ; =0x10000
	bl	_mincore
	cbz	w0, LBB0_74
; %bb.73:                               ;   in Loop: Header=BB0_39 Depth=1
	bl	___error
	str	xzr, [sp, #320]                 ; 8-byte Folded Spill
	ldrsw	x8, [x0]
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
Lloh78:
	adrp	x24, l_.str.31@PAGE
Lloh79:
	add	x24, x24, l_.str.31@PAGEOFF
	b	LBB0_85
LBB0_74:                                ;   in Loop: Header=BB0_39 Depth=1
	cmp	w21, #4, lsl #12                ; =16384
	b.ls	LBB0_76
; %bb.75:                               ;   in Loop: Header=BB0_39 Depth=1
	mov	x8, #0                          ; =0x0
	str	xzr, [sp, #320]                 ; 8-byte Folded Spill
	b	LBB0_83
LBB0_76:                                ;   in Loop: Header=BB0_39 Depth=1
	cmp	w21, #1, lsl #12                ; =4096
	b.ls	LBB0_78
; %bb.77:                               ;   in Loop: Header=BB0_39 Depth=1
	mov	x8, #0                          ; =0x0
	str	xzr, [sp, #320]                 ; 8-byte Folded Spill
	b	LBB0_80
LBB0_78:                                ;   in Loop: Header=BB0_39 Depth=1
	and	x8, x28, #0x1fff0
	ldur	q0, [x29, #-128]
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
	str	x9, [sp, #320]                  ; 8-byte Folded Spill
	cmp	x28, x8
	b.eq	LBB0_84
; %bb.79:                               ;   in Loop: Header=BB0_39 Depth=1
	tst	x28, #0xc
	b.eq	LBB0_83
LBB0_80:                                ;   in Loop: Header=BB0_39 Depth=1
	mov	x9, x8
	and	x8, x28, #0x1fffc
	movi.2d	v0, #0000000000000000
	movi.2d	v1, #0000000000000000
	ldr	x10, [sp, #320]                 ; 8-byte Folded Reload
	mov.d	v1[0], x10
LBB0_81:                                ;   Parent Loop BB0_39 Depth=1
                                        ; =>  This Inner Loop Header: Depth=2
	sub	x10, x29, #128
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
	b.ne	LBB0_81
; %bb.82:                               ;   in Loop: Header=BB0_39 Depth=1
	add.2d	v0, v1, v0
	addp.2d	d0, v0
	fmov	x9, d0
	str	x9, [sp, #320]                  ; 8-byte Folded Spill
	cmp	x28, x8
	b.eq	LBB0_84
LBB0_83:                                ;   Parent Loop BB0_39 Depth=1
                                        ; =>  This Inner Loop Header: Depth=2
	sub	x9, x29, #128
	ldrb	w9, [x9, x8]
	tst	w9, #0x1
	csel	x9, xzr, x21, eq
	ldr	x10, [sp, #320]                 ; 8-byte Folded Reload
	add	x10, x9, x10
	str	x10, [sp, #320]                 ; 8-byte Folded Spill
	add	x8, x8, #1
	cmp	x8, x28
	b.lo	LBB0_83
LBB0_84:                                ;   in Loop: Header=BB0_39 Depth=1
	str	xzr, [sp, #352]                 ; 8-byte Folded Spill
	mov	x24, #0                         ; =0x0
LBB0_85:                                ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #336]                 ; 4-byte Folded Spill
	mov	w25, #0                         ; =0x0
	mov	w8, #1                          ; =0x1
	str	w8, [sp, #260]                  ; 4-byte Folded Spill
	str	w8, [sp, #344]                  ; 4-byte Folded Spill
	mov	w8, #1                          ; =0x1
	str	x8, [sp, #280]                  ; 8-byte Folded Spill
	ldr	x8, [sp, #296]                  ; 8-byte Folded Reload
	cbnz	x8, LBB0_87
LBB0_86:                                ;   in Loop: Header=BB0_39 Depth=1
	bl	_mach_absolute_time
	str	x0, [sp, #296]                  ; 8-byte Folded Spill
LBB0_87:                                ;   in Loop: Header=BB0_39 Depth=1
	bl	_resident_now
	str	x0, [sp, #264]                  ; 8-byte Folded Spill
	add	x1, sp, #432
	mov	w0, #0                          ; =0x0
	bl	_getrusage
	ldr	x8, [sp, #464]
	cmp	w0, #0
	csel	x27, x8, xzr, eq
	mov	x26, x25
	tbnz	w25, #0, LBB0_91
; %bb.88:                               ;   in Loop: Header=BB0_39 Depth=1
	ldr	x0, [sp, #392]
	bl	_hv_vcpu_destroy
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_90
; %bb.89:                               ;   in Loop: Header=BB0_39 Depth=1
	mov	w25, #0                         ; =0x0
	sxtw	x8, w0
	cmp	x24, #0
	ldr	x9, [sp, #352]                  ; 8-byte Folded Reload
	csel	x9, x8, x9, eq
	str	x9, [sp, #352]                  ; 8-byte Folded Spill
Lloh80:
	adrp	x8, l_.str.32@PAGE
Lloh81:
	add	x8, x8, l_.str.32@PAGEOFF
	csel	x24, x8, x24, eq
	b	LBB0_92
LBB0_90:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #232]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #232]                  ; 8-byte Folded Spill
LBB0_91:                                ;   in Loop: Header=BB0_39 Depth=1
	mov	w25, #1                         ; =0x1
LBB0_92:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	w8, [sp, #336]                  ; 4-byte Folded Reload
	tbnz	w8, #0, LBB0_96
; %bb.93:                               ;   in Loop: Header=BB0_39 Depth=1
	bl	_hv_vm_destroy
                                        ; kill: def $w0 killed $w0 def $x0
	cbz	w0, LBB0_95
; %bb.94:                               ;   in Loop: Header=BB0_39 Depth=1
	mov	w25, #0                         ; =0x0
	sxtw	x8, w0
	cmp	x24, #0
	ldr	x9, [sp, #352]                  ; 8-byte Folded Reload
	csel	x9, x8, x9, eq
	str	x9, [sp, #352]                  ; 8-byte Folded Spill
Lloh82:
	adrp	x8, l_.str.33@PAGE
Lloh83:
	add	x8, x8, l_.str.33@PAGEOFF
	csel	x24, x8, x24, eq
	b	LBB0_96
LBB0_95:                                ;   in Loop: Header=BB0_39 Depth=1
	str	wzr, [sp, #260]                 ; 4-byte Folded Spill
	ldr	x8, [sp, #240]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #240]                  ; 8-byte Folded Spill
LBB0_96:                                ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #360]                  ; 8-byte Folded Reload
	cmn	x8, #1
	b.eq	LBB0_103
; %bb.97:                               ;   in Loop: Header=BB0_39 Depth=1
	ldr	w8, [sp, #260]                  ; 4-byte Folded Reload
	cbnz	w8, LBB0_103
; %bb.98:                               ;   in Loop: Header=BB0_39 Depth=1
	ldr	x0, [sp, #360]                  ; 8-byte Folded Reload
	mov	w1, #65536                      ; =0x10000
	bl	_munmap
	cbz	w0, LBB0_101
; %bb.99:                               ;   in Loop: Header=BB0_39 Depth=1
	cbz	x24, LBB0_102
; %bb.100:                              ;   in Loop: Header=BB0_39 Depth=1
	mov	w25, #0                         ; =0x0
	b	LBB0_103
LBB0_101:                               ;   in Loop: Header=BB0_39 Depth=1
	ldr	x8, [sp, #224]                  ; 8-byte Folded Reload
	add	x8, x8, #1
	str	x8, [sp, #224]                  ; 8-byte Folded Spill
	b	LBB0_103
LBB0_102:                               ;   in Loop: Header=BB0_39 Depth=1
	bl	___error
	mov	w25, #0                         ; =0x0
	ldrsw	x8, [x0]
	str	x8, [sp, #352]                  ; 8-byte Folded Spill
Lloh84:
	adrp	x24, l_.str.34@PAGE
Lloh85:
	add	x24, x24, l_.str.34@PAGEOFF
LBB0_103:                               ;   in Loop: Header=BB0_39 Depth=1
	bl	_getpid
                                        ; kill: def $w0 killed $w0 def $x0
	ldp	x17, x1, [sp, #288]             ; 16-byte Folded Reload
	sub	x8, x1, x17
	ucvtf	d0, x8
	ldp	s1, s2, [x20]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ldp	x10, x9, [sp, #368]
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	ldr	w11, [sp, #344]                 ; 4-byte Folded Reload
	cmp	w11, #0
Lloh86:
	adrp	x14, l_.str.37@PAGE
Lloh87:
	add	x14, x14, l_.str.37@PAGEOFF
Lloh88:
	adrp	x15, l_.str.36@PAGE
Lloh89:
	add	x15, x15, l_.str.36@PAGEOFF
	csel	x11, x15, x14, ne
	ldr	w12, [sp, #336]                 ; 4-byte Folded Reload
	cmp	w12, #0
	csel	x12, x14, x15, ne
	cmp	w26, #0
	csel	x13, x14, x15, ne
	cmp	w25, #0
	csel	x14, x15, x14, ne
	ldr	x15, [sp, #360]                 ; 8-byte Folded Reload
	cmn	x15, #1
	mov	w16, #65536                     ; =0x10000
	csel	x15, xzr, x16, eq
	ldr	x2, [sp, #264]                  ; 8-byte Folded Reload
	stp	x2, x27, [sp, #176]
	str	x16, [sp, #168]
	ldr	x16, [sp, #320]                 ; 8-byte Folded Reload
	stp	x15, x16, [sp, #152]
	stp	x14, x22, [sp, #136]
	stp	x12, x13, [sp, #120]
	str	x11, [sp, #112]
	stp	x1, x8, [sp, #88]
	ldr	x8, [sp, #312]                  ; 8-byte Folded Reload
	stp	x8, x17, [sp, #72]
	ldp	x26, x8, [sp, #272]             ; 16-byte Folded Reload
	stp	x10, x8, [sp, #56]
	ldr	x8, [sp, #304]                  ; 8-byte Folded Reload
	stp	x8, x9, [sp, #40]
	mov	w8, #7                          ; =0x7
	str	x8, [sp, #32]
	ldr	x8, [sp, #328]                  ; 8-byte Folded Reload
	stp	x26, x8, [sp, #16]
	stp	x26, x0, [sp]
	str	d0, [sp, #104]
Lloh90:
	adrp	x0, l_.str.35@PAGE
Lloh91:
	add	x0, x0, l_.str.35@PAGEOFF
	bl	_printf
	cbz	x24, LBB0_105
; %bb.104:                              ;   in Loop: Header=BB0_39 Depth=1
	str	x24, [sp]
Lloh92:
	adrp	x0, l_.str.38@PAGE
Lloh93:
	add	x0, x0, l_.str.38@PAGEOFF
	b	LBB0_106
LBB0_105:                               ;   in Loop: Header=BB0_39 Depth=1
Lloh94:
	adrp	x0, l_.str.39@PAGE
Lloh95:
	add	x0, x0, l_.str.39@PAGEOFF
LBB0_106:                               ;   in Loop: Header=BB0_39 Depth=1
	bl	_printf
	ldr	x8, [sp, #352]                  ; 8-byte Folded Reload
	str	x8, [sp]
Lloh96:
	adrp	x0, l_.str.40@PAGE
Lloh97:
	add	x0, x0, l_.str.40@PAGEOFF
	bl	_printf
Lloh98:
	adrp	x8, ___stdoutp@GOTPAGE
Lloh99:
	ldr	x8, [x8, ___stdoutp@GOTPAGEOFF]
Lloh100:
	ldr	x0, [x8]
	bl	_fflush
	cmp	x24, #0
	csel	w8, wzr, w25, ne
	ldr	w9, [sp, #344]                  ; 4-byte Folded Reload
	and	w8, w9, w8
	cmp	w8, #1
	b.ne	LBB0_109
; %bb.107:                              ;   in Loop: Header=BB0_39 Depth=1
	add	x26, x26, #1
	cmp	x26, x19
	b.ne	LBB0_39
; %bb.108:
	ldp	x9, x8, [sp, #224]              ; 16-byte Folded Reload
	stp	x8, x9, [sp, #32]
	ldr	x9, [sp, #208]                  ; 8-byte Folded Reload
	ldp	x10, x8, [sp, #240]             ; 16-byte Folded Reload
	stp	x10, x9, [sp, #16]
	stp	x19, x8, [sp]
Lloh101:
	adrp	x0, l_.str.41@PAGE
Lloh102:
	add	x0, x0, l_.str.41@PAGEOFF
	bl	_printf
Lloh103:
	adrp	x8, ___stdoutp@GOTPAGE
Lloh104:
	ldr	x8, [x8, ___stdoutp@GOTPAGEOFF]
Lloh105:
	ldr	x0, [x8]
	bl	_fflush
	mov	x0, x23
	bl	_free
	mov	w0, #0                          ; =0x0
	b	LBB0_8
LBB0_109:
	mov	x0, x23
	bl	_free
	mov	w0, #3                          ; =0x3
	b	LBB0_8
LBB0_110:
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
	.loh AdrpAdd	Lloh27, Lloh28
	.loh AdrpAdd	Lloh29, Lloh30
	.loh AdrpAdd	Lloh31, Lloh32
	.loh AdrpAdd	Lloh33, Lloh34
	.loh AdrpAdd	Lloh35, Lloh36
	.loh AdrpAdd	Lloh37, Lloh38
	.loh AdrpAdd	Lloh39, Lloh40
	.loh AdrpAdd	Lloh41, Lloh42
	.loh AdrpLdrGotLdr	Lloh45, Lloh46, Lloh47
	.loh AdrpAdd	Lloh43, Lloh44
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
	.loh AdrpAdd	Lloh70, Lloh71
	.loh AdrpAdd	Lloh72, Lloh73
	.loh AdrpAdd	Lloh74, Lloh75
	.loh AdrpAdd	Lloh76, Lloh77
	.loh AdrpAdd	Lloh78, Lloh79
	.loh AdrpAdd	Lloh80, Lloh81
	.loh AdrpAdd	Lloh82, Lloh83
	.loh AdrpAdd	Lloh84, Lloh85
	.loh AdrpAdd	Lloh90, Lloh91
	.loh AdrpAdd	Lloh88, Lloh89
	.loh AdrpAdd	Lloh86, Lloh87
	.loh AdrpAdd	Lloh92, Lloh93
	.loh AdrpAdd	Lloh94, Lloh95
	.loh AdrpLdrGotLdr	Lloh98, Lloh99, Lloh100
	.loh AdrpAdd	Lloh96, Lloh97
	.loh AdrpLdrGotLdr	Lloh103, Lloh104, Lloh105
	.loh AdrpAdd	Lloh101, Lloh102
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
Lloh106:
	adrp	x0, l_.str.42@PAGE
Lloh107:
	add	x0, x0, l_.str.42@PAGEOFF
	bl	_printf
Lloh108:
	adrp	x8, ___stdoutp@GOTPAGE
Lloh109:
	ldr	x8, [x8, ___stdoutp@GOTPAGEOFF]
Lloh110:
	ldr	x0, [x8]
	ldp	x29, x30, [sp, #16]             ; 16-byte Folded Reload
	add	sp, sp, #32
	b	_fflush
	.loh AdrpLdrGotLdr	Lloh108, Lloh109, Lloh110
	.loh AdrpAdd	Lloh106, Lloh107
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
Lloh111:
	adrp	x8, _mach_task_self_@GOTPAGE
Lloh112:
	ldr	x8, [x8, _mach_task_self_@GOTPAGEOFF]
Lloh113:
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
	.loh AdrpLdrGotLdr	Lloh111, Lloh112, Lloh113
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
	.asciz	"hypervisor empty VM initialization"

l_.str.12:                              ; @.str.12
	.asciz	"hypervisor empty vCPU initialization"

l_.str.13:                              ; @.str.13
	.asciz	"destroy empty initialization vCPU"

l_.str.14:                              ; @.str.14
	.asciz	"destroy empty initialization VM"

l_.str.15:                              ; @.str.15
	.asciz	"{\"kind\":\"controller_ready\",\"format\":\"aether.fresh-guest-controller/2\",\"pid\":%d,\"requestedTrials\":%ld,\"timebaseNumer\":%u,\"timebaseDenom\":%u,\"pageBytes\":%zu,\"imageBytes\":%ld,\"maximumVcpus\":%u,\"createdVmsBeforeCampaign\":1,\"destroyedVmsBeforeCampaign\":1,\"createdVcpusBeforeCampaign\":1,\"destroyedVcpusBeforeCampaign\":1,\"executedGuestsBeforeCampaign\":0,\"guestBytesBeforeCampaign\":0,\"hypervisorInitializationNs\":%.3f,\"controllerInitializationNs\":%.3f,\"controllerCurrentRssBytes\":%llu,\"controllerPeakRssBytes\":%llu}\n"

l_.str.16:                              ; @.str.16
	.asciz	"fresh guest mmap"

l_.str.17:                              ; @.str.17
	.asciz	"fresh hv_vm_create"

l_.str.18:                              ; @.str.18
	.asciz	"map fresh RX code"

l_.str.19:                              ; @.str.19
	.asciz	"map fresh RW stack/data"

l_.str.20:                              ; @.str.20
	.asciz	"fresh hv_vcpu_create"

l_.str.21:                              ; @.str.21
	.asciz	"set entry"

l_.str.22:                              ; @.str.22
	.asciz	"set EL1h"

l_.str.23:                              ; @.str.23
	.asciz	"set fresh stack"

l_.str.24:                              ; @.str.24
	.asciz	"set gross"

l_.str.25:                              ; @.str.25
	.asciz	"set adjustment"

l_.str.26:                              ; @.str.26
	.asciz	"run fresh guest"

l_.str.27:                              ; @.str.27
	.asciz	"read value"

l_.str.28:                              ; @.str.28
	.asciz	"read status"

l_.str.29:                              ; @.str.29
	.asciz	"response validation"

l_.str.30:                              ; @.str.30
	.asciz	"residency vector bounds"

l_.str.31:                              ; @.str.31
	.asciz	"guest residency observation"

l_.str.32:                              ; @.str.32
	.asciz	"destroy vCPU"

l_.str.33:                              ; @.str.33
	.asciz	"destroy VM"

l_.str.34:                              ; @.str.34
	.asciz	"unmap guest memory"

l_.str.35:                              ; @.str.35
	.asciz	"{\"kind\":\"guest_sample\",\"trial\":%ld,\"guestId\":\"%d:%ld\",\"gross\":\"%llu\",\"adjustment\":\"%llu\",\"expected\":\"%llu\",\"actual\":\"%llu\",\"status\":\"%llu\",\"exceptionReason\":%u,\"syndrome\":\"%llu\",\"startTick\":\"%llu\",\"validatedResponseTick\":\"%llu\",\"durationTicks\":\"%llu\",\"freshGuestToValidatedResponseNs\":%.3f,\"responseValidated\":%s,\"freshVmCreated\":%s,\"freshVcpuCreated\":%s,\"cleanupSucceeded\":%s,\"guestImageBytes\":%ld,\"guestMappedBytes\":%zu,\"guestResidentObservedBytes\":%zu,\"guestResidentPeakUpperBoundBytes\":%zu,\"controllerCurrentRssBytes\":%llu,\"controllerPeakRssBytes\":%llu,\"errorStage\":"

l_.str.36:                              ; @.str.36
	.asciz	"true"

l_.str.37:                              ; @.str.37
	.asciz	"false"

l_.str.38:                              ; @.str.38
	.asciz	"\"%s\""

l_.str.39:                              ; @.str.39
	.asciz	"null"

l_.str.40:                              ; @.str.40
	.asciz	",\"errorCode\":\"%lld\"}\n"

l_.str.41:                              ; @.str.41
	.asciz	"{\"kind\":\"campaign_complete\",\"completedTrials\":%ld,\"createdVms\":%llu,\"destroyedVms\":%llu,\"createdVcpus\":%llu,\"destroyedVcpus\":%llu,\"unmappedGuests\":%llu}\n"

l_.str.42:                              ; @.str.42
	.asciz	"{\"kind\":\"controller_error\",\"stage\":\"%s\",\"code\":\"%lld\"}\n"

.subsections_via_symbols
