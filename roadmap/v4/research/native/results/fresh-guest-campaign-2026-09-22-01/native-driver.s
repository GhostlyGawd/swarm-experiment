	.build_version macos, 26, 0	sdk_version 27, 0
	.section	__TEXT,__text,regular,pure_instructions
	.globl	_aether_add                     ; -- Begin function aether_add
	.p2align	2
_aether_add:                            ; @aether_add
	.cfi_startproc
; %bb.0:
	adds	x8, x0, x1
	cset	w1, vs
	csel	x0, xzr, x8, vs
	ret
	.cfi_endproc
                                        ; -- End function
	.globl	_aether_sub                     ; -- Begin function aether_sub
	.p2align	2
_aether_sub:                            ; @aether_sub
	.cfi_startproc
; %bb.0:
	subs	x8, x0, x1
	cset	w1, vs
	csel	x0, xzr, x8, vs
	ret
	.cfi_endproc
                                        ; -- End function
	.globl	_aether_mul                     ; -- Begin function aether_mul
	.p2align	2
_aether_mul:                            ; @aether_mul
	.cfi_startproc
; %bb.0:
	mul	x8, x0, x1
	smulh	x9, x0, x1
	cmp	x9, x8, asr #63
	cset	w1, ne
	csel	x0, xzr, x8, ne
	ret
	.cfi_endproc
                                        ; -- End function
	.globl	_aether_div                     ; -- Begin function aether_div
	.p2align	2
_aether_div:                            ; @aether_div
	.cfi_startproc
; %bb.0:
	cbz	x1, LBB3_4
; %bb.1:
	mov	x8, #-9223372036854775808       ; =0x8000000000000000
	cmp	x0, x8
	b.ne	LBB3_5
; %bb.2:
	cmn	x1, #1
	b.ne	LBB3_5
; %bb.3:
	mov	x0, #0                          ; =0x0
	mov	w1, #1                          ; =0x1
	ret
LBB3_4:
	mov	x0, #0                          ; =0x0
	mov	w1, #2                          ; =0x2
	ret
LBB3_5:
	mov	x8, x1
	mov	x1, #0                          ; =0x0
	sdiv	x0, x0, x8
	ret
	.cfi_endproc
                                        ; -- End function
	.globl	_aether_mod                     ; -- Begin function aether_mod
	.p2align	2
_aether_mod:                            ; @aether_mod
	.cfi_startproc
; %bb.0:
	cbz	x1, LBB4_4
; %bb.1:
	mov	x8, #-9223372036854775808       ; =0x8000000000000000
	cmp	x0, x8
	b.ne	LBB4_5
; %bb.2:
	cmn	x1, #1
	b.ne	LBB4_5
; %bb.3:
	mov	x0, #0                          ; =0x0
	mov	x1, #0                          ; =0x0
	ret
LBB4_4:
	mov	x0, #0                          ; =0x0
	mov	w1, #2                          ; =0x2
	ret
LBB4_5:
	mov	x8, x1
	mov	x1, #0                          ; =0x0
	sdiv	x9, x0, x8
	msub	x0, x9, x8, x0
	ret
	.cfi_endproc
                                        ; -- End function
	.globl	_aether_eval                    ; -- Begin function aether_eval
	.p2align	2
_aether_eval:                           ; @aether_eval
	.cfi_startproc
; %bb.0:
	mov	x8, #55051                      ; =0xd70b
	movk	x8, #28835, lsl #16
	movk	x8, #2621, lsl #32
	movk	x8, #41943, lsl #48
	smulh	x8, x0, x8
	add	x8, x8, x0
	asr	x9, x8, #7
	add	x8, x9, x8, lsr #63
	adds	x8, x8, x1
	cset	w1, vs
	csel	x0, xzr, x8, vs
	ret
	.cfi_endproc
                                        ; -- End function
	.section	__TEXT,__literal16,16byte_literals
	.p2align	4, 0x0                          ; -- Begin function main
lCPI6_0:
	.quad	99                              ; 0x63
	.quad	7                               ; 0x7
	.section	__TEXT,__text,regular,pure_instructions
	.globl	_main
	.p2align	2
_main:                                  ; @main
	.cfi_startproc
; %bb.0:
	sub	sp, sp, #272
	stp	d9, d8, [sp, #160]              ; 16-byte Folded Spill
	stp	x28, x27, [sp, #176]            ; 16-byte Folded Spill
	stp	x26, x25, [sp, #192]            ; 16-byte Folded Spill
	stp	x24, x23, [sp, #208]            ; 16-byte Folded Spill
	stp	x22, x21, [sp, #224]            ; 16-byte Folded Spill
	stp	x20, x19, [sp, #240]            ; 16-byte Folded Spill
	stp	x29, x30, [sp, #256]            ; 16-byte Folded Spill
	add	x29, sp, #256
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
	cmp	w0, #2
	b.ne	LBB6_3
; %bb.1:
	ldr	x19, [x1, #8]
Lloh0:
	adrp	x1, l_.str@PAGE
Lloh1:
	add	x1, x1, l_.str@PAGEOFF
	mov	x0, x19
	bl	_strcmp
	cbz	w0, LBB6_20
; %bb.2:
Lloh2:
	adrp	x1, l_.str.1@PAGE
Lloh3:
	add	x1, x1, l_.str.1@PAGEOFF
	mov	x0, x19
	bl	_strcmp
	cbz	w0, LBB6_45
LBB6_3:
	mov	x19, #0                         ; =0x0
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [sp, #112]
	stp	q0, q0, [sp, #80]
	str	q0, [sp, #64]
	adrp	x21, _detected_fault@PAGE
	adrp	x22, _sink@PAGE
	mov	w20, #10000                     ; =0x2710
LBB6_4:                                 ; =>This Inner Loop Header: Depth=1
	ldr	w0, [x21, _detected_fault@PAGEOFF]
	bl	_select_path
	ldr	x8, [x22, _sink@PAGEOFF]
	add	x8, x8, w0, uxtw
	str	x8, [x22, _sink@PAGEOFF]
	add	x0, sp, #64
	mov	x1, x19
	mov	w2, #7                          ; =0x7
	mov	w3, #1                          ; =0x1
	mov	w4, #1                          ; =0x1
	bl	_full_flow
	ldr	x8, [x22, _sink@PAGEOFF]
	add	x8, x8, x0
	str	x8, [x22, _sink@PAGEOFF]
	add	x19, x19, #1
	cmp	x19, x20
	b.ne	LBB6_4
; %bb.5:
	mov	w19, #34464                     ; =0x86a0
	movk	w19, #1, lsl #16
	add	x0, sp, #56
	bl	_mach_timebase_info
	ldp	s0, s1, [sp, #56]
	ucvtf	d0, d0
	ucvtf	d1, d1
	fdiv	d0, d0, d1
	str	d0, [sp]
Lloh4:
	adrp	x0, l_.str.2@PAGE
Lloh5:
	add	x0, x0, l_.str.2@PAGEOFF
	bl	_printf
	str	x19, [sp]
Lloh6:
	adrp	x0, l_.str.3@PAGE
Lloh7:
	add	x0, x0, l_.str.3@PAGEOFF
	bl	_printf
	mov	w25, #0                         ; =0x0
Lloh8:
	adrp	x23, l_.str.5@PAGE
Lloh9:
	add	x23, x23, l_.str.5@PAGEOFF
Lloh10:
	adrp	x24, l_.str.6@PAGE
Lloh11:
	add	x24, x24, l_.str.6@PAGEOFF
	mov	x8, #116548232544256            ; =0x6a0000000000
	movk	x8, #16632, lsl #48
	fmov	d8, x8
Lloh12:
	adrp	x19, l_.str.4@PAGE
Lloh13:
	add	x19, x19, l_.str.4@PAGEOFF
LBB6_6:                                 ; =>This Loop Header: Depth=1
                                        ;     Child Loop BB6_7 Depth 2
	bl	_mach_absolute_time
	mov	x20, x0
	mov	w26, #34464                     ; =0x86a0
	movk	w26, #1, lsl #16
LBB6_7:                                 ;   Parent Loop BB6_6 Depth=1
                                        ; =>  This Inner Loop Header: Depth=2
	; InlineAsm Start
	; InlineAsm End
	ldr	w0, [x21, _detected_fault@PAGEOFF]
	bl	_select_path
	ldr	x8, [x22, _sink@PAGEOFF]
	add	x8, x8, w0, uxtw
	str	x8, [x22, _sink@PAGEOFF]
	subs	w26, w26, #1
	b.ne	LBB6_7
; %bb.8:                                ;   in Loop: Header=BB6_6 Depth=1
	bl	_mach_absolute_time
	cmp	w25, #0
	csel	x26, x24, x23, eq
	sub	x20, x0, x20
	sub	x0, x29, #104
	bl	_mach_timebase_info
	ucvtf	d0, x20
	ldp	s1, s2, [x29, #-104]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	fdiv	d0, d0, d8
	str	x26, [sp]
	str	d0, [sp, #8]
	mov	x0, x19
	bl	_printf
	add	w25, w25, #1
	cmp	w25, #30
	b.ne	LBB6_6
; %bb.9:
Lloh14:
	adrp	x0, l_.str.7@PAGE
Lloh15:
	add	x0, x0, l_.str.7@PAGEOFF
	bl	_printf
	mov	w25, #0                         ; =0x0
	mov	w26, #34464                     ; =0x86a0
	movk	w26, #1, lsl #16
	mov	x8, #116548232544256            ; =0x6a0000000000
	movk	x8, #16632, lsl #48
	fmov	d8, x8
Lloh16:
	adrp	x19, l_.str.4@PAGE
Lloh17:
	add	x19, x19, l_.str.4@PAGEOFF
LBB6_10:                                ; =>This Loop Header: Depth=1
                                        ;     Child Loop BB6_11 Depth 2
	bl	_mach_absolute_time
	mov	x20, x0
	mov	x21, #0                         ; =0x0
LBB6_11:                                ;   Parent Loop BB6_10 Depth=1
                                        ; =>  This Inner Loop Header: Depth=2
	; InlineAsm Start
	; InlineAsm End
	add	x0, sp, #64
	mov	x1, x21
	mov	w2, #7                          ; =0x7
	mov	w3, #1                          ; =0x1
	mov	w4, #1                          ; =0x1
	bl	_full_flow
	ldr	x8, [x22, _sink@PAGEOFF]
	add	x8, x8, x0
	str	x8, [x22, _sink@PAGEOFF]
	add	x21, x21, #1
	cmp	x21, x26
	b.ne	LBB6_11
; %bb.12:                               ;   in Loop: Header=BB6_10 Depth=1
	bl	_mach_absolute_time
	cmp	w25, #0
	csel	x21, x24, x23, eq
	sub	x20, x0, x20
	sub	x0, x29, #104
	bl	_mach_timebase_info
	ucvtf	d0, x20
	ldp	s1, s2, [x29, #-104]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	fdiv	d0, d0, d8
	str	x21, [sp]
	str	d0, [sp, #8]
	mov	x0, x19
	bl	_printf
	add	w25, w25, #1
	cmp	w25, #30
	b.ne	LBB6_10
; %bb.13:
Lloh18:
	adrp	x0, l_.str.8@PAGE
Lloh19:
	add	x0, x0, l_.str.8@PAGEOFF
	bl	_printf
	bl	_mach_absolute_time
	mov	x19, x0
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	sub	x19, x0, x19
	sub	x0, x29, #104
	bl	_mach_timebase_info
	ucvtf	d0, x19
	ldp	s1, s2, [x29, #-104]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	str	x24, [sp]
	str	d0, [sp, #8]
Lloh20:
	adrp	x19, l_.str.4@PAGE
Lloh21:
	add	x19, x19, l_.str.4@PAGEOFF
	mov	x0, x19
	bl	_printf
	mov	w21, #1999                      ; =0x7cf
LBB6_14:                                ; =>This Inner Loop Header: Depth=1
	bl	_mach_absolute_time
	mov	x20, x0
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	sub	x20, x0, x20
	sub	x0, x29, #104
	bl	_mach_timebase_info
	ucvtf	d0, x20
	ldp	s1, s2, [x29, #-104]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	str	x23, [sp]
	str	d0, [sp, #8]
	mov	x0, x19
	bl	_printf
	subs	w21, w21, #1
	b.ne	LBB6_14
; %bb.15:
Lloh22:
	adrp	x0, l_.str.9@PAGE
Lloh23:
	add	x0, x0, l_.str.9@PAGEOFF
	bl	_printf
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	mov	x20, x0
	mov	w19, #1                         ; =0x1
	add	x0, sp, #64
	mov	x1, #0                          ; =0x0
	mov	w2, #7                          ; =0x7
	mov	w3, #1                          ; =0x1
	mov	w4, #1                          ; =0x1
	bl	_full_flow
	ldr	x8, [x22, _sink@PAGEOFF]
	add	x8, x8, x0
	str	x8, [x22, _sink@PAGEOFF]
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	sub	x20, x0, x20
	sub	x0, x29, #104
	bl	_mach_timebase_info
	ucvtf	d0, x20
	ldp	s1, s2, [x29, #-104]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	str	x24, [sp]
	str	d0, [sp, #8]
Lloh24:
	adrp	x20, l_.str.4@PAGE
Lloh25:
	add	x20, x20, l_.str.4@PAGEOFF
	mov	x0, x20
	bl	_printf
LBB6_16:                                ; =>This Inner Loop Header: Depth=1
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	mov	x21, x0
	add	x0, sp, #64
	mov	x1, x19
	mov	w2, #7                          ; =0x7
	mov	w3, #1                          ; =0x1
	mov	w4, #1                          ; =0x1
	bl	_full_flow
	ldr	x8, [x22, _sink@PAGEOFF]
	add	x8, x8, x0
	str	x8, [x22, _sink@PAGEOFF]
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	sub	x21, x0, x21
	sub	x0, x29, #104
	bl	_mach_timebase_info
	ucvtf	d0, x21
	ldp	s1, s2, [x29, #-104]
	ucvtf	d1, d1
	fmul	d0, d0, d1
	ucvtf	d1, d2
	fdiv	d0, d0, d1
	str	x23, [sp]
	str	d0, [sp, #8]
	mov	x0, x20
	bl	_printf
	add	x19, x19, #1
	cmp	x19, #2000
	b.ne	LBB6_16
; %bb.17:
	ldr	x8, [x22, _sink@PAGEOFF]
	str	x8, [sp]
Lloh26:
	adrp	x0, l_.str.10@PAGE
Lloh27:
	add	x0, x0, l_.str.10@PAGEOFF
	bl	_printf
LBB6_18:
	mov	w0, #0                          ; =0x0
LBB6_19:
	ldp	x29, x30, [sp, #256]            ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #240]            ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #224]            ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #208]            ; 16-byte Folded Reload
	ldp	x26, x25, [sp, #192]            ; 16-byte Folded Reload
	ldp	x28, x27, [sp, #176]            ; 16-byte Folded Reload
	ldp	d9, d8, [sp, #160]              ; 16-byte Folded Reload
	add	sp, sp, #272
	ret
LBB6_20:
	sub	x21, x29, #104
	add	x22, sp, #64
	add	x23, sp, #56
	stp	x22, x21, [sp, #8]
	str	x23, [sp]
Lloh28:
	adrp	x0, l_.str.11@PAGE
Lloh29:
	add	x0, x0, l_.str.11@PAGEOFF
	bl	_scanf
	cmp	w0, #3
	b.ne	LBB6_44
; %bb.21:
Lloh30:
	adrp	x19, l_.str.12@PAGE
Lloh31:
	add	x19, x19, l_.str.12@PAGEOFF
	mov	x24, #-9223372036854775808      ; =0x8000000000000000
Lloh32:
	adrp	x20, l_.str.11@PAGE
Lloh33:
	add	x20, x20, l_.str.11@PAGEOFF
	b	LBB6_24
LBB6_22:                                ;   in Loop: Header=BB6_24 Depth=1
	ldr	x8, [sp, #64]
	ldur	x9, [x29, #-104]
	mul	x10, x8, x9
	smulh	x8, x8, x9
	cmp	x8, x10, asr #63
	cset	w8, ne
	csel	x9, xzr, x10, ne
LBB6_23:                                ;   in Loop: Header=BB6_24 Depth=1
	stp	x8, x9, [sp]
	mov	x0, x19
	bl	_printf
	stp	x22, x21, [sp, #8]
	str	x23, [sp]
	mov	x0, x20
	bl	_scanf
	cmp	w0, #3
	b.ne	LBB6_44
LBB6_24:                                ; =>This Inner Loop Header: Depth=1
	ldr	w8, [sp, #56]
	cmp	w8, #1
	b.le	LBB6_32
; %bb.25:                               ;   in Loop: Header=BB6_24 Depth=1
	cmp	w8, #2
	b.eq	LBB6_22
; %bb.26:                               ;   in Loop: Header=BB6_24 Depth=1
	cmp	w8, #3
	b.eq	LBB6_35
; %bb.27:                               ;   in Loop: Header=BB6_24 Depth=1
	cmp	w8, #4
	b.ne	LBB6_60
; %bb.28:                               ;   in Loop: Header=BB6_24 Depth=1
	ldur	x9, [x29, #-104]
	cbz	x9, LBB6_41
; %bb.29:                               ;   in Loop: Header=BB6_24 Depth=1
	ldr	x10, [sp, #64]
	cmp	x10, x24
	b.ne	LBB6_43
; %bb.30:                               ;   in Loop: Header=BB6_24 Depth=1
	cmn	x9, #1
	b.ne	LBB6_43
; %bb.31:                               ;   in Loop: Header=BB6_24 Depth=1
	mov	x9, #0                          ; =0x0
	mov	w8, #0                          ; =0x0
	b	LBB6_23
LBB6_32:                                ;   in Loop: Header=BB6_24 Depth=1
	cbz	w8, LBB6_39
; %bb.33:                               ;   in Loop: Header=BB6_24 Depth=1
	cmp	w8, #1
	b.ne	LBB6_60
; %bb.34:                               ;   in Loop: Header=BB6_24 Depth=1
	ldr	x8, [sp, #64]
	ldur	x9, [x29, #-104]
	subs	x9, x8, x9
	b	LBB6_40
LBB6_35:                                ;   in Loop: Header=BB6_24 Depth=1
	ldur	x9, [x29, #-104]
	cbz	x9, LBB6_41
; %bb.36:                               ;   in Loop: Header=BB6_24 Depth=1
	ldr	x10, [sp, #64]
	cmp	x10, x24
	b.ne	LBB6_42
; %bb.37:                               ;   in Loop: Header=BB6_24 Depth=1
	cmn	x9, #1
	b.ne	LBB6_42
; %bb.38:                               ;   in Loop: Header=BB6_24 Depth=1
	mov	x9, #0                          ; =0x0
	mov	w8, #1                          ; =0x1
	b	LBB6_23
LBB6_39:                                ;   in Loop: Header=BB6_24 Depth=1
	ldr	x8, [sp, #64]
	ldur	x9, [x29, #-104]
	adds	x9, x8, x9
LBB6_40:                                ;   in Loop: Header=BB6_24 Depth=1
	cset	w8, vs
	csel	x9, xzr, x9, vs
	b	LBB6_23
LBB6_41:                                ;   in Loop: Header=BB6_24 Depth=1
	mov	w8, #2                          ; =0x2
	b	LBB6_23
LBB6_42:                                ;   in Loop: Header=BB6_24 Depth=1
	mov	w8, #0                          ; =0x0
	sdiv	x9, x10, x9
	b	LBB6_23
LBB6_43:                                ;   in Loop: Header=BB6_24 Depth=1
	mov	w8, #0                          ; =0x0
	sdiv	x11, x10, x9
	msub	x9, x11, x9, x10
	b	LBB6_23
LBB6_44:
Lloh34:
	adrp	x8, ___stdinp@GOTPAGE
Lloh35:
	ldr	x8, [x8, ___stdinp@GOTPAGEOFF]
Lloh36:
	ldr	x0, [x8]
	bl	_ferror
	mov	w8, #2                          ; =0x2
	cmp	w0, #0
	csel	w0, wzr, w8, eq
	b	LBB6_19
LBB6_45:
	add	x19, sp, #64
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [sp, #112]
	stp	q0, q0, [sp, #80]
Lloh37:
	adrp	x8, lCPI6_0@PAGE
Lloh38:
	ldr	q1, [x8, lCPI6_0@PAGEOFF]
	str	q1, [sp, #32]                   ; 16-byte Folded Spill
	str	q1, [sp, #64]
	add	x0, sp, #64
	mov	w1, #1000                       ; =0x3e8
	mov	w2, #7                          ; =0x7
	mov	w3, #1                          ; =0x1
	mov	w4, #0                          ; =0x0
	bl	_full_flow
	mov	x8, x0
	mov	w0, #2                          ; =0x2
	cmp	x8, #12
	b.ne	LBB6_19
; %bb.46:
	and	x8, x1, #0xffffffff00000000
	mov	x9, #4294967296                 ; =0x100000000
	cmp	x8, x9
	b.ne	LBB6_19
; %bb.47:
	ldr	x8, [sp, #64]
	cmp	x8, #12
	b.ne	LBB6_19
; %bb.48:
	ldr	x8, [sp, #72]
	cmp	x8, #8
	b.ne	LBB6_19
; %bb.49:
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [x19, #48]
	stp	q0, q0, [x19, #16]
	ldr	q0, [sp, #32]                   ; 16-byte Folded Reload
	str	q0, [sp, #64]
	add	x0, sp, #64
	mov	w1, #1000                       ; =0x3e8
	mov	w2, #7                          ; =0x7
	mov	w3, #1                          ; =0x1
	mov	w4, #1                          ; =0x1
	bl	_full_flow
	mov	x8, x0
	mov	w0, #3                          ; =0x3
	cmp	x8, #12
	b.ne	LBB6_19
; %bb.50:
	and	x8, x1, #0xffffffff00000000
	mov	x9, #8589934592                 ; =0x200000000
	cmp	x8, x9
	b.ne	LBB6_19
; %bb.51:
	ldr	x8, [sp, #64]
	cmp	x8, #12
	b.ne	LBB6_19
; %bb.52:
	ldr	x8, [sp, #72]
	cmp	x8, #8
	b.ne	LBB6_19
; %bb.53:
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [x19, #48]
	stp	q0, q0, [x19, #16]
	ldr	q0, [sp, #32]                   ; 16-byte Folded Reload
	str	q0, [sp, #64]
	add	x0, sp, #64
	mov	x1, #9223372036854775807        ; =0x7fffffffffffffff
	mov	x2, #9223372036854775807        ; =0x7fffffffffffffff
	mov	w3, #1                          ; =0x1
	mov	w4, #1                          ; =0x1
	bl	_full_flow
	mov	w0, #4                          ; =0x4
	mov	x8, #12884901891                ; =0x300000003
	cmp	x1, x8
	b.ne	LBB6_19
; %bb.54:
	ldr	x8, [sp, #64]
	cmp	x8, #99
	b.ne	LBB6_19
; %bb.55:
	ldr	x8, [sp, #72]
	cmp	x8, #7
	b.ne	LBB6_19
; %bb.56:
	add	x0, sp, #64
	mov	w1, #1000                       ; =0x3e8
	mov	w2, #7                          ; =0x7
	mov	w3, #0                          ; =0x0
	mov	w4, #1                          ; =0x1
	bl	_full_flow
	mov	w0, #5                          ; =0x5
	lsr	x8, x1, #32
	cmp	x8, #3
	b.ne	LBB6_19
; %bb.57:
	ldr	x8, [sp, #64]
	cmp	x8, #99
	b.ne	LBB6_19
; %bb.58:
	ldr	x8, [sp, #72]
	cmp	x8, #7
	b.ne	LBB6_19
; %bb.59:
Lloh39:
	adrp	x0, l_str@PAGE
Lloh40:
	add	x0, x0, l_str@PAGEOFF
	bl	_puts
	b	LBB6_18
LBB6_60:
	mov	w0, #2                          ; =0x2
	b	LBB6_19
	.loh AdrpAdd	Lloh0, Lloh1
	.loh AdrpAdd	Lloh2, Lloh3
	.loh AdrpAdd	Lloh12, Lloh13
	.loh AdrpAdd	Lloh10, Lloh11
	.loh AdrpAdd	Lloh8, Lloh9
	.loh AdrpAdd	Lloh6, Lloh7
	.loh AdrpAdd	Lloh4, Lloh5
	.loh AdrpAdd	Lloh16, Lloh17
	.loh AdrpAdd	Lloh14, Lloh15
	.loh AdrpAdd	Lloh20, Lloh21
	.loh AdrpAdd	Lloh18, Lloh19
	.loh AdrpAdd	Lloh24, Lloh25
	.loh AdrpAdd	Lloh22, Lloh23
	.loh AdrpAdd	Lloh26, Lloh27
	.loh AdrpAdd	Lloh28, Lloh29
	.loh AdrpAdd	Lloh32, Lloh33
	.loh AdrpAdd	Lloh30, Lloh31
	.loh AdrpLdrGotLdr	Lloh34, Lloh35, Lloh36
	.loh AdrpLdr	Lloh37, Lloh38
	.loh AdrpAdd	Lloh39, Lloh40
	.cfi_endproc
                                        ; -- End function
	.p2align	2                               ; -- Begin function select_path
_select_path:                           ; @select_path
	.cfi_startproc
; %bb.0:
	cmp	w0, #0
	mov	w8, #1                          ; =0x1
	cinc	w0, w8, ne
	ret
	.cfi_endproc
                                        ; -- End function
	.p2align	2                               ; -- Begin function full_flow
_full_flow:                             ; @full_flow
	.cfi_startproc
; %bb.0:
	sub	sp, sp, #80
	.cfi_def_cfa_offset 80
	mov	x8, x0
	ldr	x0, [x0]
	ldur	q0, [x8, #24]
	ldur	q1, [x8, #40]
	ldur	q2, [x8, #56]
	stp	q1, q2, [sp, #32]
	ldr	x9, [x8, #72]
	str	x9, [sp, #64]
	ldur	q1, [x8, #8]
	stp	q1, q0, [sp]
	cbz	w3, LBB8_4
; %bb.1:
	mov	x9, #55051                      ; =0xd70b
	movk	x9, #28835, lsl #16
	movk	x9, #2621, lsl #32
	movk	x9, #41943, lsl #48
	smulh	x10, x1, x9
	add	x10, x10, x1
	asr	x11, x10, #7
	add	x10, x11, x10, lsr #63
	adds	x10, x10, x2
	csel	x10, xzr, x10, vs
	ldr	x11, [x8, #8]
	add	x11, x11, #1
	stp	x10, x11, [x8]
	; InlineAsm Start
	; InlineAsm End
	b.vs	LBB8_5
; %bb.2:
	cbnz	w4, LBB8_5
; %bb.3:
	mov	x9, #0                          ; =0x0
	ldr	x0, [x8]
	mov	x8, #4294967296                 ; =0x100000000
	orr	x1, x8, x9
	add	sp, sp, #80
	ret
LBB8_4:
	mov	x1, #12884901891                ; =0x300000003
	add	sp, sp, #80
	ret
LBB8_5:
	ldp	q1, q0, [sp]
	stur	q0, [x8, #24]
	ldp	q0, q2, [sp, #32]
	stur	q0, [x8, #40]
	stur	q2, [x8, #56]
	str	x0, [x8]
	ldr	x10, [sp, #64]
	stur	x10, [x8, #72]
	stur	q1, [x8, #8]
	; InlineAsm Start
	; InlineAsm End
	; InlineAsm Start
	; InlineAsm End
	smulh	x9, x1, x9
	add	x9, x9, x1
	asr	x10, x9, #7
	add	x9, x10, x9, lsr #63
	adds	x10, x9, x2
	b.vc	LBB8_7
; %bb.6:
	str	x0, [x8]
	ldp	q1, q0, [sp]
	stur	q0, [x8, #24]
	ldp	q0, q2, [sp, #32]
	stur	q0, [x8, #40]
	stur	q2, [x8, #56]
	ldr	x9, [sp, #64]
	stur	x9, [x8, #72]
	stur	q1, [x8, #8]
	; InlineAsm Start
	; InlineAsm End
	mov	x8, #12884901888                ; =0x300000000
	mov	w9, #3                          ; =0x3
	orr	x1, x8, x9
	add	sp, sp, #80
	ret
LBB8_7:
	mov	x9, #0                          ; =0x0
	ldr	x11, [x8, #8]
	add	x11, x11, #1
	stp	x10, x11, [x8]
	mov	x8, #8589934592                 ; =0x200000000
	mov	x0, x10
	orr	x1, x8, x9
	add	sp, sp, #80
	ret
	.cfi_endproc
                                        ; -- End function
	.section	__TEXT,__cstring,cstring_literals
l_.str:                                 ; @.str
	.asciz	"--check"

l_.str.1:                               ; @.str.1
	.asciz	"--fallback-check"

	.section	__DATA,__data
	.p2align	2, 0x0                          ; @detected_fault
_detected_fault:
	.long	1                               ; 0x1

.zerofill __DATA,__bss,_sink,8,3        ; @sink
	.section	__TEXT,__cstring,cstring_literals
l_.str.2:                               ; @.str.2
	.asciz	"{\"clock\":\"mach_absolute_time\",\"tickNs\":%.9f,"

l_.str.3:                               ; @.str.3
	.asciz	"\"warmup\":10000,\"batchIterations\":%d,\"dispatchBatchNsPerCall\":["

l_.str.4:                               ; @.str.4
	.asciz	"%s%.9f"

l_.str.5:                               ; @.str.5
	.asciz	","

l_.str.6:                               ; @.str.6
	.space	1

l_.str.7:                               ; @.str.7
	.asciz	"],\"fullFlowBatchNsPerCall\":["

l_.str.8:                               ; @.str.8
	.asciz	"],\"timerPairNs\":["

l_.str.9:                               ; @.str.9
	.asciz	"],\"fullFlowIndividualNs\":["

l_.str.10:                              ; @.str.10
	.asciz	"],\"sink\":\"%llu\"}\n"

l_.str.11:                              ; @.str.11
	.asciz	"%u %lld %lld"

l_.str.12:                              ; @.str.12
	.asciz	"%u %lld\n"

l_str:                                  ; @str
	.asciz	"{\"threeTiers\":true,\"rollbackPreserved\":true,\"revocationTrap\":true}"

.subsections_via_symbols
