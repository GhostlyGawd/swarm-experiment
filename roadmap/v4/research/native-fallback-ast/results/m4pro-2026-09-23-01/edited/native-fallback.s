	.build_version macos, 26, 0	sdk_version 27, 0
	.section	__TEXT,__text,regular,pure_instructions
	.globl	_main                           ; -- Begin function main
	.p2align	2
_main:                                  ; @main
	.cfi_startproc
; %bb.0:
	sub	sp, sp, #240
	stp	x28, x27, [sp, #144]            ; 16-byte Folded Spill
	stp	x26, x25, [sp, #160]            ; 16-byte Folded Spill
	stp	x24, x23, [sp, #176]            ; 16-byte Folded Spill
	stp	x22, x21, [sp, #192]            ; 16-byte Folded Spill
	stp	x20, x19, [sp, #208]            ; 16-byte Folded Spill
	stp	x29, x30, [sp, #224]            ; 16-byte Folded Spill
	add	x29, sp, #224
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
	cmp	w0, #2
	b.lt	LBB0_25
; %bb.1:
	mov	x19, x1
	mov	x21, x0
	ldr	x20, [x1, #8]
Lloh0:
	adrp	x1, l_.str@PAGE
Lloh1:
	add	x1, x1, l_.str@PAGEOFF
	mov	x0, x20
	bl	_strcmp
	cbz	w0, LBB0_17
; %bb.2:
Lloh2:
	adrp	x1, l_.str.1@PAGE
Lloh3:
	add	x1, x1, l_.str.1@PAGEOFF
	mov	x0, x20
	bl	_strcmp
	mov	w20, #2                         ; =0x2
	cmp	w21, #5
	b.ne	LBB0_26
; %bb.3:
	cbnz	w0, LBB0_26
; %bb.4:
	ldr	x0, [x19, #16]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x22, x0
	ldr	x0, [x19, #24]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x21, x0
	ldr	x0, [x19, #32]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	w8, #10000                      ; =0x2710
	cmp	w22, w8
	b.ne	LBB0_26
; %bb.5:
	mov	w8, w21
	cmp	x8, #5
	b.ne	LBB0_26
; %bb.6:
	mov	w8, w0
	cmp	x8, #2000
	b.ne	LBB0_26
; %bb.7:
	mov	w0, #10000                      ; =0x2710
	mov	w1, #24                         ; =0x18
	bl	_calloc
	cbz	x0, LBB0_26
; %bb.8:
	mov	x26, #0                         ; =0x0
	add	x8, x0, #46, lsl #12            ; =188416
	add	x9, x8, #3600
	add	x8, x0, #35, lsl #12            ; =143360
	add	x8, x8, #656
	stp	x8, x9, [sp, #64]               ; 16-byte Folded Spill
	add	x8, x0, #23, lsl #12            ; =94208
	add	x8, x8, #1808
	str	x8, [sp, #56]                   ; 8-byte Folded Spill
	mov	w8, #48016                      ; =0xbb90
	add	x19, x0, x8
	str	x0, [sp, #80]                   ; 8-byte Folded Spill
	sub	x8, x0, #58, lsl #12            ; =237568
	sub	x27, x8, #2432
	b	LBB0_10
LBB0_9:                                 ;   in Loop: Header=BB0_10 Depth=1
	add	x26, x26, #1
	add	x27, x27, #24
	mov	w8, #20000                      ; =0x4e20
	cmp	x26, x8
	b.eq	LBB0_35
LBB0_10:                                ; =>This Inner Loop Header: Depth=1
	ubfx	w8, w26, #3, #13
	mov	w9, #8389                       ; =0x20c5
	mul	w8, w8, w9
	lsr	w8, w8, #20
	mov	w9, #1000                       ; =0x3e8
	msub	w8, w8, w9, w26
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [sp, #96]
	add	w8, w8, #10
	and	x28, x8, #0xffff
	str	xzr, [sp, #128]
	str	w20, [sp, #128]
	str	x28, [sp, #104]
	bl	_mach_absolute_time
	mov	x21, x0
	bl	_mach_absolute_time
	mov	x22, x0
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	mov	x23, x0
	add	x0, sp, #96
	add	x6, sp, #88
	mov	w1, #1                          ; =0x1
	mov	w2, #1                          ; =0x1
	mov	w3, #1                          ; =0x1
	mov	w5, #0                          ; =0x0
	mov	w4, #1                          ; =0x1
	bl	_invoke
	mov	x25, x0
	mov	x24, x1
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	cmp	w25, #2
	b.ne	LBB0_27
; %bb.11:                               ;   in Loop: Header=BB0_10 Depth=1
	add	x8, x28, #1
	ldr	w9, [sp, #128]
	cmp	x24, x8
	ccmp	w9, #3, #0, eq
	b.ne	LBB0_27
; %bb.12:                               ;   in Loop: Header=BB0_10 Depth=1
	ldr	x8, [sp, #104]
	cmp	x8, x24
	b.ne	LBB0_27
; %bb.13:                               ;   in Loop: Header=BB0_10 Depth=1
	ldr	x8, [sp, #112]
	cmp	x8, #888
	b.ne	LBB0_27
; %bb.14:                               ;   in Loop: Header=BB0_10 Depth=1
	ldr	x8, [sp, #88]
	cmn	x8, #1
	b.eq	LBB0_27
; %bb.15:                               ;   in Loop: Header=BB0_10 Depth=1
	adrp	x10, _observation_sink@PAGE
	ldr	x9, [x10, _observation_sink@PAGEOFF]
	add	x9, x24, x9
	add	x9, x9, #3
	str	x9, [x10, _observation_sink@PAGEOFF]
	lsr	x9, x26, #4
	cmp	x9, #625
	b.lo	LBB0_9
; %bb.16:                               ;   in Loop: Header=BB0_10 Depth=1
	sub	x9, x0, x23
	sub	x10, x22, x21
	stp	x8, x9, [x27]
	str	x10, [x27, #16]
	b	LBB0_9
LBB0_17:
	cmp	w21, #7
	b.ne	LBB0_25
; %bb.18:
	ldr	x0, [x19, #16]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x23, x0
	ldr	x0, [x19, #24]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoll
	mov	x24, x0
	ldr	x0, [x19, #32]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x21, x0
	ldr	x0, [x19, #40]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x22, x0
	ldr	x0, [x19, #48]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	w20, #2                         ; =0x2
	cmp	w23, #1
	b.hi	LBB0_26
; %bb.19:
	cmp	w21, #1
	b.hi	LBB0_26
; %bb.20:
	cmp	w22, #1
	b.hi	LBB0_26
; %bb.21:
	mov	x5, x0
	cmp	w5, #1
	b.hi	LBB0_26
; %bb.22:
	sub	x8, x24, #244, lsl #12          ; =999424
	sub	x8, x8, #577
	mov	x9, #-33921                     ; =0xffffffffffff7b7f
	movk	x9, #65505, lsl #16
	cmp	x8, x9
	b.lo	LBB0_26
; %bb.23:
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [sp, #96]
	str	xzr, [sp, #128]
	mov	w8, #2                          ; =0x2
	str	w8, [sp, #128]
	str	x24, [sp, #104]
	cbz	w23, LBB0_28
; %bb.24:
	mov	w19, #1                         ; =0x1
	b	LBB0_29
LBB0_25:
	mov	w20, #2                         ; =0x2
LBB0_26:
	mov	x0, x20
	ldp	x29, x30, [sp, #224]            ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #208]            ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #192]            ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #176]            ; 16-byte Folded Reload
	ldp	x26, x25, [sp, #160]            ; 16-byte Folded Reload
	ldp	x28, x27, [sp, #144]            ; 16-byte Folded Reload
	add	sp, sp, #240
	ret
LBB0_27:
	ldr	x0, [sp, #80]                   ; 8-byte Folded Reload
	bl	_free
	mov	w20, #3                         ; =0x3
	b	LBB0_26
LBB0_28:
	add	x8, x24, #100
	mov	w9, #3                          ; =0x3
	str	w9, [sp, #128]
	str	x8, [sp, #112]
	mov	w19, #2                         ; =0x2
LBB0_29:
	mov	w23, #1                         ; =0x1
	add	x0, sp, #96
	add	x6, sp, #88
	mov	w1, #1                          ; =0x1
	mov	x2, x19
	mov	x3, x21
	mov	x4, x22
                                        ; kill: def $w5 killed $w5 killed $x5
	bl	_invoke
	lsr	x8, x0, #32
	ldr	w20, [sp, #128]
	stp	x19, x20, [sp, #32]
	stp	x1, x23, [sp, #16]
	stp	x0, x8, [sp]
Lloh4:
	adrp	x0, l_.str.2@PAGE
Lloh5:
	add	x0, x0, l_.str.2@PAGEOFF
	bl	_printf
	cmp	w20, #2
	b.lo	LBB0_33
; %bb.30:
	ldr	x10, [sp, #104]
Lloh6:
	adrp	x8, l_.str.4@PAGE
Lloh7:
	add	x8, x8, l_.str.4@PAGEOFF
	mov	w9, #1                          ; =0x1
	stp	x9, x10, [sp, #8]
	str	x8, [sp]
Lloh8:
	adrp	x0, l_.str.3@PAGE
Lloh9:
	add	x0, x0, l_.str.3@PAGEOFF
	bl	_printf
	cmp	w20, #2
	b.eq	LBB0_33
; %bb.31:
	mov	w21, #2                         ; =0x2
	add	x22, sp, #96
Lloh10:
	adrp	x23, l_.str.5@PAGE
Lloh11:
	add	x23, x23, l_.str.5@PAGEOFF
Lloh12:
	adrp	x19, l_.str.3@PAGE
Lloh13:
	add	x19, x19, l_.str.3@PAGEOFF
LBB0_32:                                ; =>This Inner Loop Header: Depth=1
	ldr	x8, [x22, x21, lsl #3]
	stp	x21, x8, [sp, #8]
	str	x23, [sp]
	mov	x0, x19
	bl	_printf
	add	x21, x21, #1
	cmp	x20, x21
	b.ne	LBB0_32
LBB0_33:
Lloh14:
	adrp	x0, l_str@PAGE
Lloh15:
	add	x0, x0, l_str@PAGEOFF
	bl	_puts
LBB0_34:
	mov	w20, #0                         ; =0x0
	b	LBB0_26
LBB0_35:
	add	x0, sp, #96
	bl	_mach_timebase_info
	ldp	s0, s1, [sp, #96]
	ucvtf	d0, d0
	ucvtf	d1, d1
Lloh16:
	adrp	x8, _observation_sink@PAGE
Lloh17:
	ldr	x8, [x8, _observation_sink@PAGEOFF]
	fdiv	d0, d0, d1
	mov	w9, #2000                       ; =0x7d0
	stp	x9, x8, [sp, #32]
	mov	w8, #5                          ; =0x5
	mov	w9, #10000                      ; =0x2710
	stp	x9, x8, [sp, #16]
	str	d0, [sp, #8]
Lloh18:
	adrp	x8, l_.str.8@PAGE
Lloh19:
	add	x8, x8, l_.str.8@PAGEOFF
	str	x8, [sp]
Lloh20:
	adrp	x0, l_.str.7@PAGE
Lloh21:
	add	x0, x0, l_.str.7@PAGEOFF
	bl	_printf
	mov	x21, #0                         ; =0x0
	ldr	x23, [sp, #80]                  ; 8-byte Folded Reload
	add	x22, x23, #16
Lloh22:
	adrp	x20, l_.str.9@PAGE
Lloh23:
	add	x20, x20, l_.str.9@PAGEOFF
LBB0_36:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x22, #-16]
	ldr	x8, [x22], #24
	str	x8, [sp, #32]
	str	q0, [sp, #16]
	stp	xzr, x21, [sp]
	mov	x0, x20
	bl	_printf
	add	x21, x21, #1
	cmp	x21, #2000
	b.ne	LBB0_36
; %bb.37:
	mov	x21, #0                         ; =0x0
	mov	w22, #1                         ; =0x1
Lloh24:
	adrp	x20, l_.str.9@PAGE
Lloh25:
	add	x20, x20, l_.str.9@PAGEOFF
	ldr	x24, [sp, #64]                  ; 8-byte Folded Reload
LBB0_38:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x19, #-16]
	ldr	x8, [x19], #24
	str	x8, [sp, #32]
	str	q0, [sp, #16]
	stp	x22, x21, [sp]
	mov	x0, x20
	bl	_printf
	add	x21, x21, #1
	cmp	x21, #2000
	b.ne	LBB0_38
; %bb.39:
	mov	x19, #0                         ; =0x0
	mov	w21, #2                         ; =0x2
Lloh26:
	adrp	x20, l_.str.9@PAGE
Lloh27:
	add	x20, x20, l_.str.9@PAGEOFF
	ldr	x22, [sp, #56]                  ; 8-byte Folded Reload
LBB0_40:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x22, #-16]
	ldr	x8, [x22], #24
	str	x8, [sp, #32]
	str	q0, [sp, #16]
	stp	x21, x19, [sp]
	mov	x0, x20
	bl	_printf
	add	x19, x19, #1
	cmp	x19, #2000
	b.ne	LBB0_40
; %bb.41:
	mov	x19, #0                         ; =0x0
	mov	w21, #3                         ; =0x3
Lloh28:
	adrp	x20, l_.str.9@PAGE
Lloh29:
	add	x20, x20, l_.str.9@PAGEOFF
	ldr	x22, [sp, #72]                  ; 8-byte Folded Reload
LBB0_42:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x24, #-16]
	ldr	x8, [x24], #24
	str	x8, [sp, #32]
	str	q0, [sp, #16]
	stp	x21, x19, [sp]
	mov	x0, x20
	bl	_printf
	add	x19, x19, #1
	cmp	x19, #2000
	b.ne	LBB0_42
; %bb.43:
	mov	x19, #0                         ; =0x0
	mov	w21, #4                         ; =0x4
Lloh30:
	adrp	x20, l_.str.9@PAGE
Lloh31:
	add	x20, x20, l_.str.9@PAGEOFF
LBB0_44:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x22, #-16]
	ldr	x8, [x22], #24
	str	x8, [sp, #32]
	str	q0, [sp, #16]
	stp	x21, x19, [sp]
	mov	x0, x20
	bl	_printf
	add	x19, x19, #1
	cmp	x19, #2000
	b.ne	LBB0_44
; %bb.45:
	mov	x0, x23
	bl	_free
	b	LBB0_34
	.loh AdrpAdd	Lloh0, Lloh1
	.loh AdrpAdd	Lloh2, Lloh3
	.loh AdrpAdd	Lloh4, Lloh5
	.loh AdrpAdd	Lloh8, Lloh9
	.loh AdrpAdd	Lloh6, Lloh7
	.loh AdrpAdd	Lloh12, Lloh13
	.loh AdrpAdd	Lloh10, Lloh11
	.loh AdrpAdd	Lloh14, Lloh15
	.loh AdrpAdd	Lloh22, Lloh23
	.loh AdrpAdd	Lloh20, Lloh21
	.loh AdrpAdd	Lloh18, Lloh19
	.loh AdrpLdr	Lloh16, Lloh17
	.loh AdrpAdd	Lloh24, Lloh25
	.loh AdrpAdd	Lloh26, Lloh27
	.loh AdrpAdd	Lloh28, Lloh29
	.loh AdrpAdd	Lloh30, Lloh31
	.cfi_endproc
                                        ; -- End function
	.p2align	2                               ; -- Begin function invoke
_invoke:                                ; @invoke
	.cfi_startproc
; %bb.0:
	sub	sp, sp, #144
	stp	x26, x25, [sp, #64]             ; 16-byte Folded Spill
	stp	x24, x23, [sp, #80]             ; 16-byte Folded Spill
	stp	x22, x21, [sp, #96]             ; 16-byte Folded Spill
	stp	x20, x19, [sp, #112]            ; 16-byte Folded Spill
	stp	x29, x30, [sp, #128]            ; 16-byte Folded Spill
	add	x29, sp, #128
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
	mov	x8, #-1                         ; =0xffffffffffffffff
	str	x8, [x6]
	cbz	w3, LBB1_9
; %bb.1:
	mov	x21, x6
	mov	x23, x5
	mov	x24, x4
	mov	x22, x2
	mov	x20, x1
	mov	x19, x0
	ldp	q0, q1, [x0]
	stp	q0, q1, [sp, #16]
	ldr	x8, [x0, #32]
	str	x8, [sp, #48]
	str	xzr, [sp, #8]
	ldr	w8, [x0, #32]
	cmp	w8, #3
	b.hi	LBB1_3
; %bb.2:
	add	w9, w8, #1
	str	w9, [x19, #32]
	mov	w9, #777                        ; =0x309
	str	x9, [x19, x8, lsl #3]
	mov	w8, #99                         ; =0x63
	str	x8, [x19, w20, uxtw #3]
LBB1_3:
	mov	w8, #1                          ; =0x1
	adrp	x25, _fault_marker@PAGE
	str	w8, [x25, _fault_marker@PAGEOFF]
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	ldr	w8, [x25, _fault_marker@PAGEOFF]
	cbz	w8, LBB1_19
; %bb.4:
	mov	x1, #0                          ; =0x0
	ldp	q0, q1, [sp, #16]
	stp	q0, q1, [x19]
	ldr	x8, [sp, #48]
	str	x8, [x19, #32]
	; InlineAsm Start
	; InlineAsm End
	mov	x8, #8589934592                 ; =0x200000000
	mov	w9, #3                          ; =0x3
	cbz	w24, LBB1_8
; %bb.5:
	cbnz	w23, LBB1_8
; %bb.6:
	mov	x4, x0
	add	x3, sp, #8
	mov	x0, x19
	mov	x1, x20
	mov	x2, x22
	mov	x5, x21
	bl	_tier2
	cbz	w0, LBB1_11
LBB1_7:
	mov	x1, #0                          ; =0x0
	ldp	q0, q1, [sp, #16]
	stp	q0, q1, [x19]
	ldr	x8, [sp, #48]
	str	x8, [x19, #32]
	mov	x8, #4294967296                 ; =0x100000000
	mov	w9, #3                          ; =0x3
LBB1_8:
	orr	x0, x8, x9
	b	LBB1_10
LBB1_9:
	mov	x1, #0                          ; =0x0
	mov	x0, #3                          ; =0x3
	movk	x0, #2, lsl #32
LBB1_10:
	ldp	x29, x30, [sp, #128]            ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #112]            ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #96]             ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #80]             ; 16-byte Folded Reload
	ldp	x26, x25, [sp, #64]             ; 16-byte Folded Reload
	add	sp, sp, #144
	ret
LBB1_11:
	ldr	x1, [sp, #8]
	ldr	w9, [sp, #48]
	mov	w8, w20
	cmp	w9, #2
	b.lo	LBB1_16
; %bb.12:
	sub	x9, x9, #1
	add	x10, x19, #8
	add	x11, sp, #16
	orr	x11, x11, #0x8
	sub	x12, x8, #1
	b	LBB1_14
LBB1_13:                                ;   in Loop: Header=BB1_14 Depth=1
	add	x10, x10, #8
	add	x11, x11, #8
	sub	x12, x12, #1
	sub	x9, x9, #1
	cbz	x9, LBB1_16
LBB1_14:                                ; =>This Inner Loop Header: Depth=1
	cbz	x12, LBB1_13
; %bb.15:                               ;   in Loop: Header=BB1_14 Depth=1
	ldr	x13, [x11]
	ldr	x14, [x10]
	cmp	x13, x14
	b.eq	LBB1_13
	b	LBB1_7
LBB1_16:
	add	x9, sp, #16
	ldr	x8, [x9, x8, lsl #3]
	adds	x8, x8, #1
	b.vs	LBB1_7
; %bb.17:
	cmp	x1, x8
	b.ne	LBB1_7
; %bb.18:
	mov	x8, #0                          ; =0x0
	mov	w9, #2                          ; =0x2
	b	LBB1_8
LBB1_19:
	bl	_abort
	.cfi_endproc
                                        ; -- End function
	.p2align	2                               ; -- Begin function tier2
_tier2:                                 ; @tier2
	.cfi_startproc
; %bb.0:
	stp	x24, x23, [sp, #-64]!           ; 16-byte Folded Spill
	stp	x22, x21, [sp, #16]             ; 16-byte Folded Spill
	stp	x20, x19, [sp, #32]             ; 16-byte Folded Spill
	stp	x29, x30, [sp, #48]             ; 16-byte Folded Spill
	add	x29, sp, #48
	.cfi_def_cfa w29, 16
	.cfi_offset w30, -8
	.cfi_offset w29, -16
	.cfi_offset w19, -24
	.cfi_offset w20, -32
	.cfi_offset w21, -40
	.cfi_offset w22, -48
	.cfi_offset w23, -56
	.cfi_offset w24, -64
	mov	x23, x5
	mov	x24, x4
	mov	x19, x3
	mov	x20, x2
	mov	x22, x1
	mov	x21, x0
	bl	_mach_absolute_time
	sub	x8, x0, x24
	str	x8, [x23]
	ldr	w8, [x21, #32]
	cmp	w8, #3
	b.ls	LBB2_2
; %bb.1:
	mov	w0, #1                          ; =0x1
	ldp	x29, x30, [sp, #48]             ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #32]             ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #16]             ; 16-byte Folded Reload
	ldp	x24, x23, [sp], #64             ; 16-byte Folded Reload
	ret
LBB2_2:
	add	w9, w8, #1
	str	w9, [x21, #32]
	mov	w9, #889                        ; =0x379
	str	x9, [x21, x8, lsl #3]
	ldr	x8, [x21, w22, uxtw #3]
	adds	x8, x8, #1
	b.vc	LBB2_4
; %bb.3:
	mov	w0, #1                          ; =0x1
	ldp	x29, x30, [sp, #48]             ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #32]             ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #16]             ; 16-byte Folded Reload
	ldp	x24, x23, [sp], #64             ; 16-byte Folded Reload
	ret
LBB2_4:
	mov	w0, #0                          ; =0x0
	str	x8, [x21, w22, uxtw #3]
	ldr	x8, [x21, w20, uxtw #3]
	str	x8, [x19]
	ldp	x29, x30, [sp, #48]             ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #32]             ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #16]             ; 16-byte Folded Reload
	ldp	x24, x23, [sp], #64             ; 16-byte Folded Reload
	ret
	.cfi_endproc
                                        ; -- End function
	.section	__TEXT,__cstring,cstring_literals
l_.str:                                 ; @.str
	.asciz	"--case"

l_.str.1:                               ; @.str.1
	.asciz	"--benchmark"

l_.str.2:                               ; @.str.2
	.asciz	"{\"tier\":%u,\"code\":%u,\"value\":%lld,\"left\":%u,\"right\":%u,\"nextObjectId\":%u,\"records\":["

l_.str.3:                               ; @.str.3
	.asciz	"%s[%u,%lld]"

l_.str.4:                               ; @.str.4
	.space	1

l_.str.5:                               ; @.str.5
	.asciz	","

.zerofill __DATA,__bss,_fault_marker,4,2 ; @fault_marker
.zerofill __DATA,__bss,_observation_sink,8,3 ; @observation_sink
l_.str.7:                               ; @.str.7
	.asciz	"{\"kind\":\"metadata\",\"clock\":\"%s\",\"tickNs\":%.12f,\"warmup\":%u,\"trials\":%u,\"samplesPerTrial\":%u,\"sink\":\"%llu\"}\n"

l_.str.8:                               ; @.str.8
	.asciz	"mach_absolute_time"

l_.str.9:                               ; @.str.9
	.asciz	"{\"kind\":\"sample\",\"trial\":%u,\"index\":%u,\"switchTicks\":%llu,\"fullTicks\":%llu,\"timerPairTicks\":%llu}\n"

l_str:                                  ; @str
	.asciz	"]}"

.subsections_via_symbols
