    // ---- Claude instrumentation globals ----
    string array            cl_buf
    integer                 cl_n                       = 0
    string                  cl_line                    = ""
    integer                 cl_file                    = 0
    timer                   cl_clock                   = null
    timer                   cl_tick                    = null
    integer                 cl_tickn                   = 0
    real array              cl_lx
    real array              cl_ly
    real array              cl_lf
    real array              cl_lhp
    real array              cl_lmp
    integer array           cl_lord
    boolean                 cl_on                      = true
    boolean                 cl_busy                    = false
    trigger                 cl_dmg                     = null
    real                    cl_base                    = 0.0
