eps = 0.03; // epsilon
$fn = 100;

translate([-14,0,0])
difference()
{
    translate([0, 0, -1.8])
    mount_holder();

    translate([14, 0, 15])
    cube([29, 45, 30], true);
}

cylinder(h=4, d=65);


module mount_holder()
{
    rotate([0, 90, 0]) 
    import("/home/alex/Desktop/files/Mount Holder Single v5.1.stl");
}
