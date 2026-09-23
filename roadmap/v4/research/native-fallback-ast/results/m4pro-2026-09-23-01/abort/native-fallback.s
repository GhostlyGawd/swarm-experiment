	.build_version macos, 26, 0	sdk_version 27, 0
	.section	__TEXT,__text,regular,pure_instructions
	.globl	_main                           ; -- Begin function main
	.p2align	2
_main:                                  ; @main
	.cfi_startproc
; %bb.0:
	sub	sp, sp, #272
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
	cmp	w0, #2
	b.lt	LBB0_24
; %bb.1:
	mov	x21, x1
	mov	x19, x0
	ldr	x20, [x1, #8]
Lloh0:
	adrp	x1, l_.str@PAGE
Lloh1:
	add	x1, x1, l_.str@PAGEOFF
	mov	x0, x20
	bl	_strcmp
	cbz	w0, LBB0_9
; %bb.2:
Lloh2:
	adrp	x1, l_.str.1@PAGE
Lloh3:
	add	x1, x1, l_.str.1@PAGEOFF
	mov	x0, x20
	bl	_strcmp
	mov	x8, x0
	mov	w0, #2                          ; =0x2
	cmp	w19, #5
	b.ne	LBB0_23
; %bb.3:
	cbnz	w8, LBB0_23
; %bb.4:
	ldr	x0, [x21, #16]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x20, x0
	ldr	x0, [x21, #24]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x19, x0
	ldr	x0, [x21, #32]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x8, x0
	mov	w0, #2                          ; =0x2
	mov	w9, #10000                      ; =0x2710
	cmp	w20, w9
	b.ne	LBB0_23
; %bb.5:
	mov	w9, w19
	cmp	x9, #5
	b.ne	LBB0_23
; %bb.6:
	mov	w8, w8
	cmp	x8, #2000
	b.ne	LBB0_23
; %bb.7:
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [x29, #-96]
	mov	w8, #10                         ; =0xa
	stur	xzr, [x29, #-64]
	mov	w9, #2                          ; =0x2
	stur	w9, [x29, #-64]
	stur	x8, [x29, #-88]
	bl	_mach_absolute_time
	bl	_mach_absolute_time
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	mov	w8, #1                          ; =0x1
	adrp	x19, _fault_marker@PAGE
	str	w8, [x19, _fault_marker@PAGEOFF]
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	ldr	w8, [x19, _fault_marker@PAGEOFF]
	cbz	w8, LBB0_31
; %bb.8:
	mov	x2, x0
	; InlineAsm Start
	; InlineAsm End
	sub	x0, x29, #96
	add	x3, sp, #112
	mov	w1, #1                          ; =0x1
	bl	_tier2
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	mov	w0, #3                          ; =0x3
	b	LBB0_23
LBB0_9:
	cmp	w19, #7
	b.ne	LBB0_24
; %bb.10:
	ldr	x0, [x21, #16]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x23, x0
	ldr	x0, [x21, #24]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoll
	mov	x19, x0
	ldr	x0, [x21, #32]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x22, x0
	ldr	x0, [x21, #40]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x20, x0
	ldr	x0, [x21, #48]
	mov	x1, #0                          ; =0x0
	mov	w2, #10                         ; =0xa
	bl	_strtoul
	mov	x8, x0
	mov	w0, #2                          ; =0x2
	cmp	w23, #1
	b.hi	LBB0_23
; %bb.11:
	cmp	w22, #1
	b.hi	LBB0_23
; %bb.12:
	cmp	w20, #1
	b.hi	LBB0_23
; %bb.13:
	cmp	w8, #1
	b.hi	LBB0_23
; %bb.14:
	sub	x9, x19, #244, lsl #12          ; =999424
	sub	x9, x9, #577
	mov	x10, #-33921                    ; =0xffffffffffff7b7f
	movk	x10, #65505, lsl #16
	cmp	x9, x10
	b.lo	LBB0_23
; %bb.15:
	movi.2d	v0, #0000000000000000
	stp	q0, q0, [sp, #64]
	str	xzr, [sp, #96]
	mov	w21, #2                         ; =0x2
	str	w21, [sp, #96]
	str	x19, [sp, #72]
	cbz	w23, LBB0_25
; %bb.16:
	mov	w23, #1                         ; =0x1
	cbz	w22, LBB0_26
LBB0_17:
	mov	x19, x8
	ldp	q0, q1, [sp, #64]
	stp	q0, q1, [sp, #112]
	ldr	x8, [sp, #96]
	str	x8, [sp, #144]
	mov	w8, #1                          ; =0x1
	adrp	x21, _fault_marker@PAGE
	str	w8, [x21, _fault_marker@PAGEOFF]
	; InlineAsm Start
	; InlineAsm End
	bl	_mach_absolute_time
	ldr	w8, [x21, _fault_marker@PAGEOFF]
	cbz	w8, LBB0_31
; %bb.18:
	mov	x8, #0                          ; =0x0
	; InlineAsm Start
	; InlineAsm End
	mov	x9, #3                          ; =0x3
	movk	x9, #2, lsl #32
	cbz	w20, LBB0_21
; %bb.19:
	cbnz	w19, LBB0_21
; %bb.20:
	mov	x2, x0
	add	x0, sp, #64
	add	x3, sp, #56
	mov	w1, #1                          ; =0x1
	bl	_tier2
	mov	x8, #0                          ; =0x0
	ldp	q0, q1, [sp, #112]
	stp	q0, q1, [sp, #64]
	ldr	x9, [sp, #144]
	str	x9, [sp, #96]
	mov	x9, #3                          ; =0x3
	movk	x9, #1, lsl #32
LBB0_21:
	ldr	w21, [sp, #96]
	lsr	x10, x9, #32
	stp	x23, x21, [sp, #32]
	mov	w11, #1                         ; =0x1
	stp	x8, x11, [sp, #16]
	stp	x9, x10, [sp]
Lloh4:
	adrp	x0, l_.str.2@PAGE
Lloh5:
	add	x0, x0, l_.str.2@PAGEOFF
	bl	_printf
	cmp	w21, #2
	b.lo	LBB0_30
; %bb.22:
	ldr	x19, [sp, #72]
	b	LBB0_27
LBB0_23:
	ldp	x29, x30, [sp, #256]            ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #240]            ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #224]            ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #208]            ; 16-byte Folded Reload
	add	sp, sp, #272
	ret
LBB0_24:
	mov	w0, #2                          ; =0x2
	ldp	x29, x30, [sp, #256]            ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #240]            ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #224]            ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #208]            ; 16-byte Folded Reload
	add	sp, sp, #272
	ret
LBB0_25:
	add	x9, x19, #100
	mov	w21, #3                         ; =0x3
	str	w21, [sp, #96]
	str	x9, [sp, #80]
	mov	w23, #2                         ; =0x2
	cbnz	w22, LBB0_17
LBB0_26:
                                        ; kill: def $w23 killed $w23 killed $x23 def $x23
	stp	x23, x21, [sp, #32]
	mov	w8, #1                          ; =0x1
	stp	xzr, x8, [sp, #16]
	mov	w8, #2                          ; =0x2
	mov	w9, #3                          ; =0x3
	stp	x9, x8, [sp]
Lloh6:
	adrp	x0, l_.str.2@PAGE
Lloh7:
	add	x0, x0, l_.str.2@PAGEOFF
	bl	_printf
LBB0_27:
Lloh8:
	adrp	x8, l_.str.4@PAGE
Lloh9:
	add	x8, x8, l_.str.4@PAGEOFF
	mov	w9, #1                          ; =0x1
	stp	x9, x19, [sp, #8]
	str	x8, [sp]
Lloh10:
	adrp	x0, l_.str.3@PAGE
Lloh11:
	add	x0, x0, l_.str.3@PAGEOFF
	bl	_printf
	cmp	w21, #2
	b.eq	LBB0_30
; %bb.28:
	mov	w20, w21
	mov	w21, #2                         ; =0x2
	add	x22, sp, #64
Lloh12:
	adrp	x23, l_.str.5@PAGE
Lloh13:
	add	x23, x23, l_.str.5@PAGEOFF
Lloh14:
	adrp	x19, l_.str.3@PAGE
Lloh15:
	add	x19, x19, l_.str.3@PAGEOFF
LBB0_29:                                ; =>This Inner Loop Header: Depth=1
	ldr	x8, [x22, x21, lsl #3]
	stp	x21, x8, [sp, #8]
	str	x23, [sp]
	mov	x0, x19
	bl	_printf
	add	x21, x21, #1
	cmp	x20, x21
	b.ne	LBB0_29
LBB0_30:
Lloh16:
	adrp	x0, l_str@PAGE
Lloh17:
	add	x0, x0, l_str@PAGEOFF
	bl	_puts
	mov	w0, #0                          ; =0x0
	ldp	x29, x30, [sp, #256]            ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #240]            ; 16-byte Folded Reload
	ldp	x22, x21, [sp, #224]            ; 16-byte Folded Reload
	ldp	x24, x23, [sp, #208]            ; 16-byte Folded Reload
	add	sp, sp, #272
	ret
LBB0_31:
	bl	_abort
	.loh AdrpAdd	Lloh0, Lloh1
	.loh AdrpAdd	Lloh2, Lloh3
	.loh AdrpAdd	Lloh4, Lloh5
	.loh AdrpAdd	Lloh6, Lloh7
	.loh AdrpAdd	Lloh10, Lloh11
	.loh AdrpAdd	Lloh8, Lloh9
	.loh AdrpAdd	Lloh14, Lloh15
	.loh AdrpAdd	Lloh12, Lloh13
	.loh AdrpAdd	Lloh16, Lloh17
	.cfi_endproc
                                        ; -- End function
	.p2align	2                               ; -- Begin function tier2
_tier2:                                 ; @tier2
	.cfi_startproc
; %bb.0:
	stp	x22, x21, [sp, #-48]!           ; 16-byte Folded Spill
	stp	x20, x19, [sp, #16]             ; 16-byte Folded Spill
	stp	x29, x30, [sp, #32]             ; 16-byte Folded Spill
	add	x29, sp, #32
	.cfi_def_cfa w29, 16
	.cfi_offset w30, -8
	.cfi_offset w29, -16
	.cfi_offset w19, -24
	.cfi_offset w20, -32
	.cfi_offset w21, -40
	.cfi_offset w22, -48
	mov	x21, x3
	mov	x22, x2
	mov	x19, x1
	mov	x20, x0
	bl	_mach_absolute_time
	sub	x8, x0, x22
	str	x8, [x21]
	ldr	w8, [x20, #32]
	cmp	w8, #3
	b.hi	LBB1_2
; %bb.1:
	add	w9, w8, #1
	str	w9, [x20, #32]
	mov	w9, #777                        ; =0x309
	str	x9, [x20, x8, lsl #3]
	mov	w8, #99                         ; =0x63
	str	x8, [x20, w19, uxtw #3]
LBB1_2:
	ldp	x29, x30, [sp, #32]             ; 16-byte Folded Reload
	ldp	x20, x19, [sp, #16]             ; 16-byte Folded Reload
	ldp	x22, x21, [sp], #48             ; 16-byte Folded Reload
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
l_str:                                  ; @str
	.asciz	"]}"

.subsections_via_symbols
