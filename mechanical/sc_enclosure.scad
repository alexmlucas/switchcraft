//-- Layout, taken from the PCB (electronics/switchcraft/switchcraft.kicad_pcb)
//   The USB edge of the board (KiCad top, Y = 56.92) is the box FRONT, so:
//     from back = 146.648 - KiCad Y      (board's bottom edge, KiCad Y = 146.648)
//     from left = 185.23  - KiCad X      (board's right edge,  KiCad X = 185.23)
//   Each jack, button and LED pair shares one of six rows.
pcbKicadBackY  = 146.648;
pcbKicadLeftX  = 185.23;
rowKicadY      = [63.37, 77.51, 91.66, 105.99, 120.5, 135.0];
rowFromBack    = [for (y = rowKicadY) pcbKicadBackY - y];
jackFromBack   = rowFromBack;

// Columns (switch and LED centres, KiCad X)
buttonFromLeft = [pcbKicadLeftX - 167.2,  pcbKicadLeftX - 113.23];   // 18.03, 72.00
ledFromLeft    = [pcbKicadLeftX - 159.64, pcbKicadLeftX - 120.79];   // 25.59, 64.44
picoFromLeft   = pcbKicadLeftX - 140.2;                              // USB centre, 45.03

buttonRadius   = 3.5;
ledRadius      = 1.75;

//-- Mini-jack (PJ-320A) slots -------------------------------------
//   The round front collar of each jack sticks ~1.9 mm out past the PCB
//   edge, into the side wall. Where the jacks are, the wall is two layers:
//   the base's inner ridge (0.9 mm) and the lid's outer skirt (0.9 mm),
//   with a 0.2 mm gap. Each layer gets its own U round the collar:
//     lid  : straight sides from the PCB top up to the collar centre,
//            then a semicircle over it (open at the bottom, so the lid
//            drops over the collar)
//     base : a semicircle under the collar, then straight sides up to
//            the top of the ridge (open at the top, so the board drops in)
//   The two straight parts are cut 1 mm deep, from outside (lid skirt)
//   and from inside (base ridge), so each misses the other shell.
jackNoseWidth  = 5.0;   // collar diameter (footprint: 5.0)
jackNoseHeight = 6.0;   // collar top above the PCB top (measure; 5-6)
jackClearance  = 0.4;   // added all round

jackSlotR      = jackNoseWidth / 2 + jackClearance;
jackCentreZ    = jackNoseHeight - jackNoseWidth / 2;   // collar centre above PCB top
jackLayerDepth = 1.0;   // cuts one wall layer only (YAPP adds 0.02 each side)

//-- Snap joins: centre of each snap, from the end of the front/back wall
snapJoinFromEnd = 22;

//   (These are set before the include: OpenSCAD evaluates a variable the
//   library already defines, such as cutoutsLeft, at the library's
//   position, so anything those use must already exist there.)

include <YAPP_Box/YAPPgenerator_v3.scad>

pcbLength = 89.728;
pcbWidth = 89.970;
pcbThickness = 1;

wallThickness = 2;
basePlaneThickness = 2;
lidPlaneThickness = 2;

lidWallHeight =5;
baseWallHeight = 7;

// Top of the base ridge, above the PCB top (base wall top minus standoff and PCB).
// A function, so the cutout lists (evaluated inside the library) can use it.
function jackRidgeTopZ() = baseWallHeight - standoffHeight - pcbThickness;

// Snaps on the front and back walls (box coordinates), a symmetric pair
// per wall, clear of the USB opening in the middle of the front.
// (snapJoinFromEnd is set at the top of the file.)
snapJoins =
[
    [snapJoinFromEnd, 5, yappFront, yappBack, yappCenter, yappSymmetric]
];


//===================================================================
//  *** Cutouts ***
//    There are 6 cutouts one for each surface:
//      cutoutsBase (Bottom), cutoutsLid (Top), cutoutsFront, cutoutsBack, cutoutsLeft, cutoutsRight
//-------------------------------------------------------------------
//  Default origin = yappCoordBox: box[0,0,0]
//
//                        Required                Not Used        Note
//----------------------+-----------------------+---------------+------------------------------------
//  yappRectangle       | width, length         | radius        |
//  yappCircle          | radius                | width, length |
//  yappRoundedRect     | width, length, radius |               |     
//  yappCircleWithFlats | width, radius         | length        | length=distance between flats
//  yappCircleWithKey   | width, length, radius |               | width = key width length=key depth
//                      |                       |               |  (negative indicates outside of circle)
//  yappPolygon         | width, length         | radius        | yappPolygonDef object must be
//                      |                       |               | provided
//  yappRing            | width, length, radius |               | radius = outer radius, 
//                      |                       |               | length = inner radius
//                      |                       |               | width = connection between rings
//                      |                       |               |   0 = No connectors
//                      |                       |               |   positive = 2 connectors
//                      |                       |               |   negative = 4 connectors
//  yappSphere          | width, radius         |               | Width = Sphere center distance from
//                      |                       |               |   center of depth.  negative = below
//                      |                       |               | radius = sphere radius
//----------------------+-----------------------+---------------+------------------------------------
//
//  Parameters:
//   Required:
//    p(0) = from Back
//    p(1) = from Left
//    p(2) = width
//    p(3) = length
//    p(4) = radius
//    p(5) = shape : { yappRectangle | yappCircle | yappPolygon | yappRoundedRect 
//                     | yappCircleWithFlats | yappCircleWithKey | yappSphere }
//  Optional:
//    p(6) = depth : Default = 0/Auto : 0 = Auto (plane thickness)
//    p(7) = angle : Default = 0
//    n(a) = { yappPolygonDef } : Required if shape = yappPolygon specified -
//    n(b) = { yappMaskDef } : If a yappMaskDef object is added it will be used as a mask 
//                             for the cutout.
//    n(c) = { [yappMaskDef, hOffset, vOffset, rotation] } : If a list for a mask is added 
//                              it will be used as a mask for the cutout. With the Rotation
//                              and offsets applied. This can be used to fine tune the mask
//                              placement within the opening.
//    n(d) = { <yappCoordPCB> | yappCoordBox | yappCoordBoxInside }
//    n(e) = { <yappOrigin>, yappCenter }
//    n(f) = { <yappGlobalOrigin>, yappAltOrigin } // Only affects Top(lid), Back and Right Faces
//    n(g) = [yappPCBName, "XXX"] : Specify a PCB. Defaults to [yappPCBName, "Main"]
//    n(h) = { yappFromInside } Make the cut from the inside towards the outside
//-------------------------------------------------------------------
cutoutsBase = 
[
];

cutoutsLid  = concat(
    // buttons
    [for (b = rowFromBack, c = buttonFromLeft) [b, c, 10, 10, buttonRadius, yappCircle, yappCenter]],
    // LEDs
    [for (b = rowFromBack, c = ledFromLeft)    [b, c, 10, 10, ledRadius,    yappCircle, yappCenter]]
);

cutoutsFront =  
[
    //    p(0) = from Back
    //    p(1) = from Left
    //    p(2) = width
    //    p(3) = length
    //    p(4) = radius
    //    p(5) = shape :

     [picoFromLeft, 1, 9, 5, 3, yappRectangle, yappCenter],
];


cutoutsBack = 
[
];

cutoutsLeft  = concat(
    // round part, through both shells
    [for (b = jackFromBack) [b, jackCentreZ, 10, 10, jackSlotR, yappCircle, yappCenter]],
    // lid: straight sides from the PCB top up to the collar centre
    [for (b = jackFromBack) [b, jackCentreZ / 2, 2 * jackSlotR, jackCentreZ, 0,
                             yappRectangle, jackLayerDepth, 0, yappCenter]],
    // base ridge: straight sides from the collar centre up to the ridge top
    [for (b = jackFromBack) [b, (jackCentreZ + jackRidgeTopZ()) / 2, 2 * jackSlotR, jackRidgeTopZ() - jackCentreZ, 0,
                             yappRectangle, jackLayerDepth, 0, yappCenter, yappFromInside]]
);

cutoutsRight = concat(
    // round part, through both shells
    [for (b = jackFromBack) [b, jackCentreZ, 10, 10, jackSlotR, yappCircle, yappCenter]],
    // lid: straight sides from the PCB top up to the collar centre
    [for (b = jackFromBack) [b, jackCentreZ / 2, 2 * jackSlotR, jackCentreZ, 0,
                             yappRectangle, jackLayerDepth, 0, yappCenter]],
    // base ridge: straight sides from the collar centre up to the ridge top
    [for (b = jackFromBack) [b, (jackCentreZ + jackRidgeTopZ()) / 2, 2 * jackSlotR, jackRidgeTopZ() - jackCentreZ, 0,
                             yappRectangle, jackLayerDepth, 0, yappCenter, yappFromInside]]
);

YAPPgenerate();