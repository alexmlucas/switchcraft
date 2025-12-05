
cutOutSpacer = 14.140;
cutOutStart = 83;
buttonCompensate = 0.25;
ledOffset = 7.560;
buttonOffset = 53.970;

include <YAPPgenerator_v3.scad>

pcbLength = 89.728;
pcbWidth = 89.970;
pcbThickness = 1;

wallThickness = 2;
basePlaneThickness = 2;
lidPlaneThickness = 2;

lidWallHeight =5;
baseWallHeight = 7;

snapJoins =
[
    [10, 5, yappLeft, yappRight]
    , [pcbLength - 10, 5, yappLeft, yappRight] 
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
//                              it will be used as a mask for the cutout. With the Rotation cutOutStart + (cutOutSpacer * 2), 5, 10, 10, 3, yappCircle],
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

cutoutsLid  = 
[
    // buttons
     [cutOutStart, 17.838, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer), 17.838, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 2), 17.838, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 3), 17.838, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 4), 17.838, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 5), 17.838, 10, 10, 3.5, yappCircle, yappCenter],
     
     [cutOutStart, 17.838 + buttonOffset, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer), 17.838 + buttonOffset, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 2), 17.838 + buttonOffset, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 3), 17.838 + buttonOffset, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 4), 17.838 + buttonOffset, 10, 10, 3.5, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 5), 17.838 + buttonOffset, 10, 10, 3.5, yappCircle, yappCenter],
     
     //leds
     
     [cutOutStart, 17.838 + ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer), 17.838 + ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 2), 17.838 + ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 3), 17.838 + ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 4), 17.838 + ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 5), 17.838 + ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     
     [cutOutStart, 17.838 + buttonOffset - ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer), 17.838 + buttonOffset - ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 2), 17.838 + buttonOffset - ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 3) , 17.838 + buttonOffset - ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 4) , 17.838 + buttonOffset - ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 5) , 17.838 + buttonOffset - ledOffset, 10, 10, 1.75, yappCircle, yappCenter],
     

];

cutoutsFront =  
[
    //    p(0) = from Back
    //    p(1) = from Left
    //    p(2) = width
    //    p(3) = length
    //    p(4) = radius
    //    p(5) = shape :

     [pcbWidth/2, 1, 9, 5, 3, yappRectangle, yappCenter],
];


cutoutsBack = 
[
];

cutoutsLeft =   
[
//    p(0) = from Back
//    p(1) = from Left
//    p(2) = width
//    p(3) = length
//    p(4) = radius
//    p(5) = shape :

     [cutOutStart, 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer), 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 2), 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 3), 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 4), 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 5), 2, 10, 10, 3, yappCircle, yappCenter],
];

cutoutsRight =  
[
//    p(0) = from Back
//    p(1) = from Left
//    p(2) = width
//    p(3) = length
//    p(4) = radius
//    p(5) = shape :

     [cutOutStart, 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer), 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 2), 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 3), 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 4), 2, 10, 10, 3, yappCircle, yappCenter],
     [cutOutStart - (cutOutSpacer * 5), 2, 10, 10, 3, yappCircle, yappCenter],
];

YAPPgenerate();