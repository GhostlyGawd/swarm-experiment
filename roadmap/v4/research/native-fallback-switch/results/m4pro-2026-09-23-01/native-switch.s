	.build_version macos, 26, 0	sdk_version 27, 0
	.section	__TEXT,__text,regular,pure_instructions
	.globl	_main                           ; -- Begin function main
	.p2align	2
_main:                                  ; @main
	.cfi_startproc
; %bb.0:
	cmp	w0, #2
	b.lt	LBB0_9
; %bb.1:
	sub	sp, sp, #224
	stp	x28, x27, [sp, #128]            ; 16-byte Folded Spill
	stp	x26, x25, [sp, #144]            ; 16-byte Folded Spill
	stp	x24, x23, [sp, #160]            ; 16-byte Folded Spill
	stp	x22, x21, [sp, #176]            ; 16-byte Folded Spill
	stp	x20, x19, [sp, #192]            ; 16-byte Folded Spill
	stp	x29, x30, [sp, #208]            ; 16-byte Folded Spill
	add	x29, sp, #208
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
	mov	x21, x1
	mov	x19, x0
	ldr	x20, [x1, #8]
Lloh0:
	adrp	x1, l_.str@PAGE
Lloh1:
	add	x1, x1, l_.str@PAGEOFF
	mov	x0, x20
	bl	_strcmp
	cbz	w0, LBB0_18
; %bb.2:
Lloh2:
	adrp	x1, l_.str.1@PAGE
Lloh3:
	add	x1, x1, l_.str.1@PAGEOFF
	mov	x0, x20
	bl	_strcmp
	mov	w10, #2                         ; =0x2
	cmp	w19, #5
	b.ne	LBB0_36
; %bb.3:
	cbnz	w0, LBB0_36
; %bb.4:
	ldr	x0, [x21, #16]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x22, x0
	ldr	x0, [x21, #24]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x19, x0
	ldr	x0, [x21, #32]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	w10, #2                         ; =0x2
	mov	w8, #10000                      ; =0x2710
	cmp	w22, w8
	b.ne	LBB0_36
; %bb.5:
	mov	w8, w19
	cmp	x8, #5
	b.ne	LBB0_36
; %bb.6:
	mov	w8, w0
	cmp	x8, #2000
	b.ne	LBB0_36
; %bb.7:
	mov	w0, #10000                      ; =0x2710
	mov	w1, #24                         ; =0x18
	bl	_calloc
	mov	w10, #2                         ; =0x2
	cbz	x0, LBB0_36
; %bb.8:
	mov	x26, #0                         ; =0x0
	add	x8, x0, #46, lsl #12            ; =188416
	add	x9, x8, #3600
	add	x8, x0, #35, lsl #12            ; =143360
	add	x8, x8, #656
	stp	x8, x9, [sp, #48]               ; 16-byte Folded Spill
	add	x8, x0, #23, lsl #12            ; =94208
	add	x28, x8, #1808
	mov	w8, #48016                      ; =0xbb90
	add	x19, x0, x8
	str	x0, [sp, #64]                   ; 8-byte Folded Spill
	sub	x8, x0, #58, lsl #12            ; =237568
	sub	x27, x8, #2432
	b	LBB0_11
LBB0_9:
	mov	w0, #2                          ; =0x2
	ret
LBB0_10:                                ;   in Loop: Header=BB0_11 Depth=1
	add	x26, x26, #1
	add	x27, x27, #24
	mov	w8, #20000                      ; =0x4e20
	cmp	x26, x8
	mov	w10, #2                         ; =0x2
	b.eq	LBB0_37
LBB0_11:                                ; =>This Inner Loop Header: Depth=1
	ubfx	w8, w26, #3, #13
	mov	w9, #8389                       ; =0x20c5
	mul	w8, w8, w9
	lsr	w8, w8, #20
	mov	w9, #1000                       ; =0x3e8
	msub	w8, w8, w9, w26
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [sp, #80]
	add	w8, w8, #10
	and	x20, x8, #0xffff
	str	xzr, [sp, #112]
	str	w10, [sp, #112]
	str	x20, [sp, #88]
	bl	_mach_absolute_time
	mov	x21, x0
	bl	_mach_absolute_time
	mov	x22, x0
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	mov	x23, x0
	add	x0, sp, #80
	add	x7, sp, #72
	mov	w1, #1                          ; =0x1
	mov	w2, #1                          ; =0x1
	mov	w3, #1                          ; =0x1
	mov	w4, #1                          ; =0x1
	mov	w6, #0                          ; =0x0
	mov	w5, #1                          ; =0x1
	bl	_invoke
	mov	x25, x0
	mov	x24, x1
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	cmp	w25, #2
	b.ne	LBB0_28
; %bb.12:                               ;   in Loop: Header=BB0_11 Depth=1
	add	x8, x20, #1
	ldr	w9, [sp, #112]
	cmp	x24, x8
	ccmp	w9, #3, #0, eq
	b.ne	LBB0_28
; %bb.13:                               ;   in Loop: Header=BB0_11 Depth=1
	ldr	x8, [sp, #88]
	cmp	x8, x24
	b.ne	LBB0_28
; %bb.14:                               ;   in Loop: Header=BB0_11 Depth=1
	ldr	x8, [sp, #96]
	cmp	x8, #888
	b.ne	LBB0_28
; %bb.15:                               ;   in Loop: Header=BB0_11 Depth=1
	ldr	x8, [sp, #72]
	cmn	x8, #1
	b.eq	LBB0_28
; %bb.16:                               ;   in Loop: Header=BB0_11 Depth=1
	adrp	x10, _observation_sink@PAGE
	ldr	x9, [x10, _observation_sink@PAGEOFF]
	add	x9, x24, x9
	add	x9, x9, #3
	str	x9, [x10, _observation_sink@PAGEOFF]
	lsr	x9, x26, #4
	cmp	x9, #625
	b.lo	LBB0_10
; %bb.17:                               ;   in Loop: Header=BB0_11 Depth=1
	sub	x9, x0, x23
	sub	x10, x22, x21
	stp	x8, x9, [x27]
	str	x10, [x27, #16]
	b	LBB0_10
LBB0_18:
	cmp	w19, #8
	b.ne	LBB0_27
; %bb.19:
	ldr	x0, [x21, #16]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x19, x0
	ldr	x0, [x21, #24]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x24, x0
	ldr	x0, [x21, #32]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoll
	mov	x25, x0
	ldr	x0, [x21, #40]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x22, x0
	ldr	x0, [x21, #48]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x23, x0
	ldr	x0, [x21, #56]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	w10, #2                         ; =0x2
	cmp	w19, #2
	b.hi	LBB0_36
; %bb.20:
	cmp	w24, #1
	b.hi	LBB0_36
; %bb.21:
	cmp	w22, #1
	b.hi	LBB0_36
; %bb.22:
	cmp	w23, #1
	b.hi	LBB0_36
; %bb.23:
	mov	x6, x0
	cmp	w6, #1
	b.hi	LBB0_36
; %bb.24:
	sub	x8, x25, #244, lsl #12          ; =999424
	sub	x8, x8, #577
	mov	x9, #-33921                     ; =0xffffffffffff7b7f
	movk	x9, #65505, lsl #16
	cmp	x8, x9
	b.lo	LBB0_36
; %bb.25:
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [sp, #80]
	str	xzr, [sp, #112]
	mov	w8, #2                          ; =0x2
	str	w8, [sp, #112]
	str	x25, [sp, #88]
	cbz	w24, LBB0_29
; %bb.26:
	mov	w20, #1                         ; =0x1
	b	LBB0_30
LBB0_27:
	mov	w10, #2                         ; =0x2
	b	LBB0_36
LBB0_28:
	ldr	x0, [sp, #64]                   ; 8-byte Folded Reload
	bl	_free
	mov	w10, #3                         ; =0x3
	b	LBB0_36
LBB0_29:
	add	x8, x25, #100
	mov	w9, #3                          ; =0x3
	str	w9, [sp, #112]
	str	x8, [sp, #96]
	mov	w20, #2                         ; =0x2
LBB0_30:
	mov	w24, #1                         ; =0x1
	add	x0, sp, #80
	add	x7, sp, #72
	mov	w1, #1                          ; =0x1
	mov	x2, x20
	mov	x3, x19
	mov	x4, x22
	mov	x5, x23
                                        ; kill: def $w6 killed $w6 killed $x6
	bl	_invoke
	lsr	x8, x0, #32
	ldr	w21, [sp, #112]
	stp	x20, x21, [sp, #32]
	stp	x1, x24, [sp, #16]
	stp	x0, x8, [sp]
Lloh4:
	adrp	x0, l_.str.2@PAGE
Lloh5:
	add	x0, x0, l_.str.2@PAGEOFF
	bl	_printf
	cmp	w21, #2
	b.lo	LBB0_34
; %bb.31:
	ldr	x10, [sp, #88]
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
	cmp	w21, #2
	b.eq	LBB0_34
; %bb.32:
	mov	w20, #2                         ; =0x2
	add	x22, sp, #80
Lloh10:
	adrp	x23, l_.str.5@PAGE
Lloh11:
	add	x23, x23, l_.str.5@PAGEOFF
Lloh12:
	adrp	x19, l_.str.3@PAGE
Lloh13:
	add	x19, x19, l_.str.3@PAGEOFF
LBB0_33:                                ; =>This Inner Loop Header: Depth=1
	ldr	x8, [x22, x20, lsl #3]
	stp	x20, x8, [sp, #8]
	str	x23, [sp]
	mov	x0, x19
	bl	_printf
	add	x20, x20, #1
	cmp	x21, x20
	b.ne	LBB0_33
LBB0_34:
Lloh14:
	adrp	x0, l_str@PAGE
Lloh15:
	add	x0, x0, l_str@PAGEOFF
	bl	_puts
LBB0_35:
	mov	w10, #0                         ; =0x0
LBB0_36:
	ldp	x29, x30, [sp, #208]            ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #192]            ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #176]            ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #160]            ; 16-byte Folded Reload
	ldp	x26, x25, [sp, #144]            ; 16-byte Folded Reload
	ldp	x28, x27, [sp, #128]            ; 16-byte Folded Reload
	add	sp, sp, #224
	mov	x0, x10
	ret
LBB0_37:
	add	x0, sp, #80
	bl	_mach_timebase_info
	ldp	s0, s1, [sp, #80]
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
	ldr	x23, [sp, #64]                  ; 8-byte Folded Reload
	add	x22, x23, #16
Lloh22:
	adrp	x20, l_.str.9@PAGE
Lloh23:
	add	x20, x20, l_.str.9@PAGEOFF
LBB0_38:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x22, #-16]
	ldr	x8, [x22], #24
	str	x8, [sp, #32]
	str	q0, [sp, #16]
	stp	xzr, x21, [sp]
	mov	x0, x20
	bl	_printf
	add	x21, x21, #1
	cmp	x21, #2000
	b.ne	LBB0_38
; %bb.39:
	mov	x21, #0                         ; =0x0
	mov	w22, #1                         ; =0x1
Lloh24:
	adrp	x20, l_.str.9@PAGE
Lloh25:
	add	x20, x20, l_.str.9@PAGEOFF
	ldr	x24, [sp, #48]                  ; 8-byte Folded Reload
LBB0_40:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x19, #-16]
	ldr	x8, [x19], #24
	str	x8, [sp, #32]
	str	q0, [sp, #16]
	stp	x22, x21, [sp]
	mov	x0, x20
	bl	_printf
	add	x21, x21, #1
	cmp	x21, #2000
	b.ne	LBB0_40
; %bb.41:
	mov	x19, #0                         ; =0x0
	mov	w21, #2                         ; =0x2
Lloh26:
	adrp	x20, l_.str.9@PAGE
Lloh27:
	add	x20, x20, l_.str.9@PAGEOFF
LBB0_42:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x28, #-16]
	ldr	x8, [x28], #24
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
	mov	w21, #3                         ; =0x3
Lloh28:
	adrp	x20, l_.str.9@PAGE
Lloh29:
	add	x20, x20, l_.str.9@PAGEOFF
	ldr	x22, [sp, #56]                  ; 8-byte Folded Reload
LBB0_44:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x24, #-16]
	ldr	x8, [x24], #24
	str	x8, [sp, #32]
	str	q0, [sp, #16]
	stp	x21, x19, [sp]
	mov	x0, x20
	bl	_printf
	add	x19, x19, #1
	cmp	x19, #2000
	b.ne	LBB0_44
; %bb.45:
	mov	x19, #0                         ; =0x0
	mov	w21, #4                         ; =0x4
Lloh30:
	adrp	x20, l_.str.9@PAGE
Lloh31:
	add	x20, x20, l_.str.9@PAGEOFF
LBB0_46:                                ; =>This Inner Loop Header: Depth=1
	ldur	q0, [x22, #-16]
	ldr	x8, [x22], #24
	str	x8, [sp, #32]
	str	q0, [sp, #16]
	stp	x21, x19, [sp]
	mov	x0, x20
	bl	_printf
	add	x19, x19, #1
	cmp	x19, #2000
	b.ne	LBB0_46
; %bb.47:
	mov	x0, x23
	bl	_free
	b	LBB0_35
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
	sub	sp, sp, #128
	stp	x26, x25, [sp, #48]             ; 16-byte Folded Spill
	stp	x24, x23, [sp, #64]             ; 16-byte Folded Spill
	stp	x22, x21, [sp, #80]             ; 16-byte Folded Spill
	stp	x20, x19, [sp, #96]             ; 16-byte Folded Spill
	stp	x29, x30, [sp, #112]            ; 16-byte Folded Spill
	add	x29, sp, #112
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
	str	x8, [x7]
	cbz	w4, LBB1_4
; %bb.1:
	mov	x22, x0
	ldp	q0, q1, [x0]
	stp	q0, q1, [sp]
	ldr	x8, [x0, #32]
	str	x8, [sp, #32]
	ldr	w8, [x0, #32]
	cmp	w8, #4
	b.hs	LBB1_12
; %bb.2:
	mov	x19, x7
	mov	x24, x6
	mov	x25, x5
	mov	x23, x3
	mov	x20, x2
	mov	x21, x1
	cmp	w3, #0
	mov	w9, #777                        ; =0x309
	mov	w10, #888                       ; =0x378
	csel	x9, x10, x9, eq
	add	w10, w8, #1
	str	w10, [x22, #32]
	str	x9, [x22, x8, lsl #3]
	cbz	w3, LBB1_5
; %bb.3:
	mov	w8, #99                         ; =0x63
	str	x8, [x22, w21, uxtw #3]
	b	LBB1_6
LBB1_4:
	mov	x1, #0                          ; =0x0
	mov	x0, #3                          ; =0x3
	movk	x0, #2, lsl #32
	b	LBB1_11
LBB1_5:
	ldr	x8, [x22, w21, uxtw #3]
	add	x1, x8, #1
	str	x1, [x22, w21, uxtw #3]
	ldr	x8, [x22, w20, uxtw #3]
	mov	x9, sp
	ldr	x9, [x9, w21, uxtw #3]
	add	x10, x9, #1
	mov	x11, #9223372036854775807       ; =0x7fffffffffffffff
	cmp	x9, x11
	ccmp	x8, x10, #0, ne
	ccmp	x1, x8, #0, eq
	b.eq	LBB1_10
LBB1_6:
	mov	w8, #1                          ; =0x1
	adrp	x26, _fault_marker@PAGE
	str	w8, [x26, _fault_marker@PAGEOFF]
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	ldr	w8, [x26, _fault_marker@PAGEOFF]
	cbz	w8, LBB1_12
; %bb.7:
	mov	x4, x0
	mov	x1, #0                          ; =0x0
	ldp	q0, q1, [sp]
	stp	q0, q1, [x22]
	ldr	x8, [sp, #32]
	str	x8, [x22, #32]
	; InlineAsm Start
	; InlineAsm End
	mov	x0, #3                          ; =0x3
	movk	x0, #2, lsl #32
	cbz	w25, LBB1_11
; %bb.8:
	cbnz	w24, LBB1_11
; %bb.9:
	cmp	w23, #2
	cset	w6, eq
	mov	x1, sp
	mov	x0, x22
	mov	x2, x21
	mov	x3, x20
	mov	x5, x19
	bl	_tier2
	b	LBB1_11
LBB1_10:
	mov	w0, #1                          ; =0x1
LBB1_11:
	ldp	x29, x30, [sp, #112]            ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #96]             ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #80]             ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #64]             ; 16-byte Folded Reload
	ldp	x26, x25, [sp, #48]             ; 16-byte Folded Reload
	add	sp, sp, #128
	ret
LBB1_12:
	bl	_abort
	.cfi_endproc
                                        ; -- End function
	.p2align	2                               ; -- Begin function tier2
_tier2:                                 ; @tier2
	.cfi_startproc
; %bb.0:
	stp	x26, x25, [sp, #-80]!           ; 16-byte Folded Spill
	stp	x24, x23, [sp, #16]             ; 16-byte Folded Spill
	stp	x22, x21, [sp, #32]             ; 16-byte Folded Spill
	stp	x20, x19, [sp, #48]             ; 16-byte Folded Spill
	stp	x29, x30, [sp, #64]             ; 16-byte Folded Spill
	add	x29, sp, #64
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
	mov	x23, x6
	mov	x24, x5
	mov	x25, x4
	mov	x22, x3
	mov	x21, x2
	mov	x20, x1
	mov	x19, x0
	bl	_mach_absolute_time
	sub	x8, x0, x25
	str	x8, [x24]
	ldr	w8, [x19, #32]
	cmp	w8, #4
	b.hs	LBB2_6
; %bb.1:
	cmp	w23, #0
	mov	w9, #777                        ; =0x309
	mov	w10, #888                       ; =0x378
	csel	x9, x10, x9, eq
	add	w10, w8, #1
	str	w10, [x19, #32]
	str	x9, [x19, x8, lsl #3]
	cbz	w23, LBB2_3
; %bb.2:
	mov	w8, #99                         ; =0x63
	str	x8, [x19, w21, uxtw #3]
	b	LBB2_4
LBB2_3:
	ldr	x8, [x19, w21, uxtw #3]
	add	x1, x8, #1
	str	x1, [x19, w21, uxtw #3]
	ldr	x8, [x19, w22, uxtw #3]
	ldr	x9, [x20, w21, uxtw #3]
	add	x10, x9, #1
	mov	x11, #9223372036854775807       ; =0x7fffffffffffffff
	cmp	x9, x11
	ccmp	x8, x10, #0, ne
	ccmp	x1, x8, #0, eq
	b.eq	LBB2_5
LBB2_4:
	mov	x1, #0                          ; =0x0
	ldp	q0, q1, [x20]
	ldr	x8, [x20, #32]
	str	x8, [x19, #32]
	stp	q0, q1, [x19]
	mov	x0, #3                          ; =0x3
	movk	x0, #1, lsl #32
	ldp	x29, x30, [sp, #64]             ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #48]             ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #32]             ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #16]             ; 16-byte Folded Reload
	ldp	x26, x25, [sp], #80             ; 16-byte Folded Reload
	ret
LBB2_5:
	mov	w0, #2                          ; =0x2
	ldp	x29, x30, [sp, #64]             ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #48]             ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #32]             ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #16]             ; 16-byte Folded Reload
	ldp	x26, x25, [sp], #80             ; 16-byte Folded Reload
	ret
LBB2_6:
	bl	_abort
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
